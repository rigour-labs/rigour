import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildRecord } from './record.js';
import { storedReviewerResult } from './stored.js';

let repo: string;
const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
const FINGERPRINT = 'abcdef0123456789';

/** A full verdict on HEAD as the reviewer stores it: the branch's state, the verdict, its open items and its record. */
function store(head: string, base = git('rev-parse', 'main^{commit}')) {
    const dir = path.join(repo, '.git', 'rigour-reviewer');
    fs.mkdirSync(path.join(dir, 'branches'), { recursive: true });
    const verdictFile = path.join(dir, `${head}.${FINGERPRINT.slice(0, 8)}.json`);
    const verdict = { prior_points: [], redundant: [], reads: [], scans: [], merge_impact: [], findings: [], carried: [], resolved_previous: [],
        goal: [{ item: 'refunds are capped', met: true, file: 'src/refund.ts', line: 1, quote: 'return Math.min(amount, charge);' }],
        lessons: [{ lesson: 'page every query', applies: false }], inputs: { fingerprint: FINGERPRINT, base, reviewers: ['claude'], body_sha256: 'b0d1' } };
    const record = buildRecord({ head, base: 'b'.repeat(40), scope: 'full', verdict: verdict as never, accounted: { open: [], advisory: [], unverified: [], notes: [], resolved: [], answerInReply: [], disputed: [], dismissed: [] }, judges: [{ reviewer: 'claude' }], lessonsServed: 1, humanReviews: 0 });
    fs.writeFileSync(verdictFile, JSON.stringify(verdict));
    fs.writeFileSync(verdictFile.replace(/\.json$/, '.open.json'), '[]');
    fs.writeFileSync(verdictFile.replace(/\.json$/, '.record.json'), JSON.stringify(record));
    fs.writeFileSync(path.join(dir, 'branches', 'feat.json'), JSON.stringify({ head, verdict: verdictFile, mode: 'full', chain: 0, rulesHash: '', reviewsKey: '', at: 'now' }));
    return verdictFile;
}

/** A repository with `main`, and `feat` one commit ahead, under the given line-ending setting. */
function setUp(autocrlf: string): void {
    // The temporary folder as the OS names it, not its real path (macOS /var is /private/var; Windows' temp folder is an
    // 8.3 short name): git names the store by the real path, so the store's paths and these spellings differ.
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'stored-verdict-'));
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 't');
    git('config', 'commit.gpgsign', 'false');
    git('config', 'core.autocrlf', autocrlf);
    git('commit', '-q', '--allow-empty', '-m', 'init');
    git('checkout', '-q', '-b', 'feat');
    fs.mkdirSync(path.join(repo, 'src'));
    fs.writeFileSync(path.join(repo, 'src/refund.ts'), 'export const cap = (amount: number, charge: number) => {\n  return Math.min(amount, charge);\n};\n');
    git('add', '-A');
    git('commit', '-qm', 'refunds');
}
afterEach(() => fs.rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

describe.each(['false', 'true'])('storedReviewerResult, core.autocrlf %s', crlf => {
    beforeEach(() => setUp(crlf));

    it('reads a full verdict stored for this exact commit, with its record, goal answers checked against the checkout, and lesson answers', async () => {
        store(git('rev-parse', 'HEAD'));
        const result = await storedReviewerResult(repo, 'main');
        expect(result).toMatchObject({ outcome: 'passed', cached: true, goal: [{ item: 'refunds are capped', met: true, checked: true }], lessonAnswers: { repeated: 0, notRepeated: 1 }, stored: { bodySha256: 'b0d1' } });
        expect(result?.record?.head).toBe(git('rev-parse', 'HEAD'));
    });

    it('has none when HEAD moved on, or the record was changed after it was written', async () => {
        const file = store(git('rev-parse', 'HEAD'));
        const record = JSON.parse(fs.readFileSync(file.replace(/\.json$/, '.record.json'), 'utf8'));
        fs.writeFileSync(file.replace(/\.json$/, '.record.json'), JSON.stringify({ ...record, verified: { ...record.verified, blocking: [], rules: { served: 9, followed: 9, broken: 0, not_applicable: 0 } } }));
        expect(await storedReviewerResult(repo, 'main')).toBeUndefined();
        store(git('rev-parse', 'HEAD'));
        git('commit', '-q', '--allow-empty', '-m', 'more');
        expect(await storedReviewerResult(repo, 'main')).toBeUndefined();
    });

    it('has none when this run reviews uncommitted work: changes to tracked files, or no branch base at all', async () => {
        store(git('rev-parse', 'HEAD'));
        expect(await storedReviewerResult(repo, undefined)).toBeUndefined();
        fs.appendFileSync(path.join(repo, 'src/refund.ts'), '// not reviewed\n');
        expect(await storedReviewerResult(repo, 'main')).toBeUndefined();
    });

    it('reads the verdict on a branch behind its base, which the reviewer stored against the base\'s tip', async () => {
        git('checkout', '-q', 'main');
        git('commit', '-q', '--allow-empty', '-m', 'main moved on');
        git('checkout', '-q', 'feat');
        store(git('rev-parse', 'HEAD'));
        expect(git('merge-base', 'main', 'HEAD')).not.toBe(git('rev-parse', 'main'));
        expect(await storedReviewerResult(repo, 'main')).toMatchObject({ outcome: 'passed', cached: true });
    });

    it('has none when the verdict reviewed the branch against another base', async () => {
        store(git('rev-parse', 'HEAD'), 'f'.repeat(40));
        expect(await storedReviewerResult(repo, 'main')).toBeUndefined();
    });
});
