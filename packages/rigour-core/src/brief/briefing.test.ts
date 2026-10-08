import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeLessons, type ReviewLesson } from '../review-learning/lessons.js';
import { readThread } from '../task/thread.js';
import { BRIEFING_MAX_ITEMS, briefFile, briefingText, briefTask, buildBriefing, buildFileBriefing, fileBriefingText } from './briefing.js';

let repo: string;
const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
const write = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    fs.writeFileSync(path.join(repo, file), text);
};
const lesson = (id: string, state: ReviewLesson['state'], file: string, text: string, symbols: string[], pr: number): ReviewLesson => ({
    id, text, file, symbols, state, evidence: [{ kind: 'outcome', pr, comment: 'c', author: 'senior', source: 'person' }],
} as ReviewLesson);

beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'brief-'));
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 't');
    git('config', 'commit.gpgsign', 'false');
    write('AGENTS.md', [
        '- Every job in `src/jobs/` must take `withLock()` before its first read; a job that reads first double-sends.',
        '',
        'Prefer `fetchWithTimeout()` over a bare call in `src/jobs/` when talking to partner APIs; a hung request blocks the queue.',
        '',
    ].join('\n'));
    write('services/billing/AGENTS.md', '- Every amount in `services/billing/` must be integer cents via `toCents()`; never a float.\n');
    write('src/jobs/retry.ts', 'export async function retryJob() {}\n');
    write('services/billing/charge.ts', 'export const charge = 1;\n');
    git('add', '-A');
    git('commit', '-qm', 'init');
    writeLessons(repo, [
        lesson('v1', 'verified', 'src/jobs/retry.ts', 'Bound the retry window at both ends: `updated_at` between since and until.', ['retryJob'], 12),
        lesson('c1', 'candidate', 'src/jobs/retry.ts', 'Log every retry at debug level in `retryJob`.', ['retryJob'], 13),
        lesson('r1', 'rejected', 'src/jobs/retry.ts', 'Wrap `retryJob` in a second try/catch.', ['retryJob'], 14),
    ]);
});
afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

describe('the briefing', () => {
    it("gives the files' requirement rules first, then verified lessons, settled points, then guidance, each cited; never a candidate", () => {
        const briefing = buildBriefing(repo, { goal: 'retry the partner job with backoff', files: ['src/jobs/retry.ts'] });
        expect(briefing.items.map(i => [i.kind, i.requirement ?? false, i.cite])).toEqual([
            ['rule', true, 'AGENTS.md'],
            ['lesson', false, 'learned in PR #12'],
            ['settled', false, 'learned in PR #14'],
            ['rule', false, 'AGENTS.md'],
        ]);
        expect(briefing.items[1].text).toContain('Bound the retry window at both ends');
        expect(briefing.items.some(i => i.text.includes('debug level'))).toBe(false); // a candidate is not the team's yet
        // A team whose reviewer is shown candidates (review_lessons: all) is briefed with them too.
        expect(buildBriefing(repo, { goal: 'retry the partner job with backoff', files: ['src/jobs/retry.ts'], lessons: 'all' }).items.some(i => i.text.includes('debug level'))).toBe(true);
        expect(briefing.items.some(i => i.text.includes('integer cents'))).toBe(false); // billing's rule, not this task's folder
        // A rule that only shares words with the task, naming none of its paths or identifiers, is not briefed.
        write('AGENTS.md', fs.readFileSync(path.join(repo, 'AGENTS.md'), 'utf8') + '\nEvery partner retry job must log its backoff and the partner it retried for, always.\n');
        expect(buildBriefing(repo, { goal: 'retry the partner job with backoff', files: ['src/jobs/retry.ts'] }).items.some(i => i.text.includes('log its backoff'))).toBe(false);
        const text = briefingText(briefing);
        expect(text.split('\n')[1]).toMatch(/^1\. \[must\] Every job in `src\/jobs\/` must take `withLock\(\)`.* \(AGENTS\.md\)$/);
        expect(text).toContain('[settled] settled against, do not do or raise it: Wrap `retryJob` in a second try/catch. (learned in PR #14)');
    });

    it("serves a folder's own rules to a task in that folder, cited with the folder", () => {
        const briefing = buildBriefing(repo, { goal: 'charge in cents', files: ['services/billing/charge.ts'] });
        expect(briefing.items.map(i => i.cite)).toContain('services/billing/AGENTS.md, for services/billing/');
    });

    it('never gives more than ten items, and says nothing when nothing applies', () => {
        write('AGENTS.md', Array.from({ length: 30 }, (_, i) => `- Every job in \`src/jobs/\` must call \`step${i}()\` before \`retryJob\` reads.\n`).join('\n'));
        expect(buildBriefing(repo, { goal: 'retry job', files: ['src/jobs/retry.ts'], limit: 50 }).items).toHaveLength(BRIEFING_MAX_ITEMS);
        expect(buildBriefing(repo, { goal: 'retry job', files: ['src/jobs/retry.ts'], limit: 3 }).items).toHaveLength(3);
        const nothing = buildBriefing(repo, { goal: 'update the readme wording', files: ['README.md'] });
        expect(nothing.items).toEqual([]);
        expect(briefingText(nothing)).toBe('');
    });

    it("reads the task's likely files from the branch's own changes and the goal's words, and the goal from the branch when none is given", () => {
        git('checkout', '-qb', 'feat/retry-backoff');
        write('src/jobs/retry.ts', 'export async function retryJob() { return 1; }\n');
        git('commit', '-qam', 'work');
        const briefing = buildBriefing(repo);
        expect(briefing.goal).toBe('feat retry backoff');
        expect(briefing.files).toEqual(['src/jobs/retry.ts']);
        expect(buildBriefing(repo, { goal: 'charge the customer' }).files).toEqual(['src/jobs/retry.ts', 'services/billing/charge.ts']);
    });

    it("records what was briefed on the task's thread, by id", () => {
        git('checkout', '-qb', 'feat/retry');
        const briefing = briefTask(repo, { goal: 'retry', files: ['src/jobs/retry.ts'], session: 's1', agent: 'claude' });
        const [event] = readThread(repo)!.events;
        expect(event).toMatchObject({ kind: 'brief', session: 's1', agent: 'claude', items: briefing.items.length, ids: briefing.items.map(i => i.id), files: ['src/jobs/retry.ts'] });
    });

});

describe("a file's briefing, on the agent's first edit of it", () => {
    it("gives at most three items: the file's requirement rules, its lessons and settled points; never guidance or another file's", () => {
        const briefing = buildFileBriefing(repo, 'src/jobs/retry.ts');
        expect(briefing.items.map(i => [i.kind, i.cite])).toEqual([['rule', 'AGENTS.md'], ['lesson', 'learned in PR #12'], ['settled', 'learned in PR #14']]);
        expect(briefing.items.some(i => i.text.includes('fetchWithTimeout'))).toBe(false); // guidance waits for review
        expect(fileBriefingText(briefing).split('\n')[0]).toBe('Rigour, before you edit src/jobs/retry.ts: what this team asks of this file.');
        expect(buildFileBriefing(repo, 'services/billing/charge.ts').items.map(i => i.cite)).toEqual(['services/billing/AGENTS.md, for services/billing/']);
        expect(buildFileBriefing(repo, 'README.md').items).toEqual([]);
        expect(fileBriefingText(buildFileBriefing(repo, 'README.md'))).toBe('');
        expect(buildFileBriefing(repo, 'src/jobs/retry.ts', { lessons: 'all' }).items.length).toBe(3); // still three, with candidates in play
    });

    it('records the file it briefed on the thread', () => {
        git('checkout', '-qb', 'feat/retry');
        briefFile(repo, 'src/jobs/retry.ts', { session: 's9', agent: 'claude' });
        expect(readThread(repo)!.events[0]).toMatchObject({ kind: 'brief', file: 'src/jobs/retry.ts', session: 's9', items: 3, files: ['src/jobs/retry.ts'] });
    });
});
