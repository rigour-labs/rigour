import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReviewerResult } from '@rigour-labs/core';

const asked = vi.hoisted(() => ({ options: [] as unknown[] }));
vi.mock('@rigour-labs/core', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@rigour-labs/core')>()),
    reviewerInputs: () => ({}),
    runReviewer: async (_cwd: string, _base: string, _config: unknown, _exec: unknown, _progress: unknown, options: unknown) => { asked.options.push(options); return { outcome: 'passed' }; },
}));

const { printReviewer, reviewerFor, reviewerJson } = await import('./review-reviewer.js');

let out: string[];
beforeEach(() => {
    out = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => void out.push(args.join(' ')));
});
afterEach(() => {
    vi.restoreAllMocks();
});

const LOCK = { id: 'abcdef0123', kind: 'finding' as const, class: 'correctness', file: 'src/job.ts', line: 2, issue: 'returns before the lock', consequence: 'two runs send the same email', reviewer: 'claude+codex' };
const base: ReviewerResult = { outcome: 'findings', items: [LOCK], unverified: [], resolved: [], answerInReply: [], notes: [{ ...LOCK, id: 'n1', issue: 'could be shorter', consequence: undefined }], advisory: [], disputed: [{ ...LOCK, id: 'd1', issue: 'maybe slow' }], dropped: [{ ...LOCK, id: 'x1' }], dismissed: [], reviewers: ['claude', 'codex'], scope: 'full', cached: false, dismissable: true, costUsd: 0.42, tokens: { input: 26565, output: 24 } };

describe('the reviewer as the CLI prints it', () => {
    it('shows what ran against what was asked, why, what was refused, and only confirmed findings as open', () => {
        printReviewer({ ...base, mode: { asked: 'panel', ran: 'single', source: 'user', degraded: '3 judges asked, claude could run (not installed: codex)', refused: ['mode single (flag) refused: rigour.yml sets review.reviewer.panel: required'] } });
        const text = out.join('\n');
        expect(text).toContain('panel asked (user), single ran: 3 judges asked, claude could run (not installed: codex)');
        expect(text).toContain('mode single (flag) refused');
        expect(text).toContain('OPEN');
        expect(text).toContain('consequence: two runs send the same email');
        expect(text).toContain('not a bug? rigour dismiss abcdef0123');
        expect(text).not.toContain('disputed, never blocks'); // folded: what is shown gets the discipline of what blocks
        expect(text).toMatch(/Also seen, never blocking: .*1 working note.*1 disputed.*1 refuted by the other judges.*--notes lists them/);
        expect(text).toContain('1 open item(s), $0.42, 26,589 tokens'); // a Codex judge reports tokens, not dollars
    });

    it('shows at most five verified should-fixes, folds the rest, and lists everything with --notes', () => {
        const advisory = Array.from({ length: 6 }, (_, i) => ({ ...LOCK, id: `s${i}`, issue: `should fix ${i}` }));
        printReviewer({ ...base, advisory });
        const text = out.join('\n');
        expect(text.match(/should fix \(verified, never blocks\)/g)).toHaveLength(5);
        expect(text).toContain('1 more should-fix');
        out = [];
        printReviewer({ ...base, advisory }, { notes: true });
        const all = out.join('\n');
        expect(all.match(/should fix \(verified, never blocks\)/g)).toHaveLength(6);
        expect(all).toContain('disputed, never blocks (no majority)');
        expect(all).toContain('note, never blocks');
        expect(all).not.toContain('Also seen, never blocking');
    });

    it('returns every decision in JSON', () => {
        expect(reviewerJson({ ...base, spentUsd: 2.2 })).toMatchObject({ cost_usd: 0.42, spent_usd: 2.2 }); // every run, a failed one included
        expect(reviewerJson({ ...base, cached: true })).toMatchObject({ spent_usd: 0 }); // a cached verdict ran nothing
        expect(reviewerJson({ ...base, mode: { asked: 'panel', ran: 'panel', source: 'team' } })).toMatchObject({ blocks: true, mode: { ran: 'panel' }, disputed: [{ id: 'd1' }], notes: [{ id: 'n1' }], shown: { blocking: 1, should_fix: 0 }, dropped: [{ id: 'x1' }] });
    });

    it('offers "not a bug" only where the team allows dismissals', () => {
        printReviewer({ ...base, dismissable: false });
        expect(out.join('\n')).not.toContain('rigour dismiss');
    });
});

describe('rigour review --status', () => {
    it('runs in a repository with no verdict yet, instead of crashing on the branch lookup', async () => {
        const { execFileSync } = await import('child_process');
        const fs = await import('fs');
        const os = await import('os');
        const path = await import('path');
        const { printStatus } = await import('./review-reviewer.js');
        const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'status-'));
        execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
        execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repo });
        const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        try {
            expect(await printStatus(repo, true)).toBe(0);
            expect(JSON.parse(String(log.mock.calls[0][0]))).toMatchObject({ branch: 'main' });
        } finally {
            log.mockRestore();
            fs.rmSync(repo, { recursive: true, force: true });
        }
    });
});

describe('the reviewer without pull request context', () => {
    it('is asked for with --blind or RIGOUR_REVIEWER_BLIND=1, and never otherwise', async () => {
        const review = {} as any;
        asked.options = [];
        await reviewerFor('/repo', 'main', {} as any, false, {}, review, { goal: undefined, orchestrator: undefined, blind: true });
        await reviewerFor('/repo', 'main', {} as any, false, {}, review, { goal: undefined, orchestrator: undefined, blind: false });
        vi.stubEnv('RIGOUR_REVIEWER_BLIND', '1');
        await reviewerFor('/repo', 'main', {} as any, false, {}, review, { goal: undefined, orchestrator: undefined, blind: false });
        vi.unstubAllEnvs();
        expect(asked.options.map(o => (o as { blind?: boolean }).blind)).toEqual([true, undefined, true]);
    });

    it('says so in the output and the JSON', () => {
        printReviewer({ ...base, outcome: 'passed', items: [], blind: true });
        expect(out.join('\n')).toContain('reviewed without pull request context');
        expect(reviewerJson({ ...base, blind: true })).toMatchObject({ blind: true });
        expect(reviewerJson(base)).toMatchObject({ blind: false });
    });
});
