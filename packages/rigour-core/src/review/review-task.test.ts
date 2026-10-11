import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { diffFromGit } from './git-diff.js';
import { acknowledgeReview } from './review-ack.js';
import { buildReviewTask } from './review-task.js';
import { exportReviewed, readLedger, REVIEWED_FILE } from './ledger.js';
import { reviewAckMessage } from '../hooks/stop-review.js';
import { seedLessons } from '../review-learning/seed-lessons.test-support.js';

let repo: string;
const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
const write = (body: string) => fs.writeFileSync(path.join(repo, 'sync.ts'), body);

const BEFORE = [
    'export async function syncOrders(db, cursor) {',
    '  const rows = await page(cursor);',
    '  return rows;',
    '}',
    'function label(name) {',
    '  return name;',
    '}',
    '',
].join('\n');

const AFTER = [
    'export async function syncOrders(db, cursor) {',
    '  const rows = await page(cursor);',
    "  await db.from('orders').upsert(rows);",
    '  return rows;',
    '}',
    'function label(name) {',
    '  return name.trim();',
    '}',
    '',
].join('\n');

beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'review-task-'));
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 't');
    git('config', 'commit.gpgsign', 'false');
    write(BEFORE);
    git('add', '-A');
    git('commit', '-q', '-m', 'base');
    write(AFTER);
});
afterEach(() => { fs.rmSync(repo, { recursive: true, force: true }); });

describe('review task and acknowledgements', () => {
    it('asks about the risky changed function only, with questions from its signals', () => {
        const task = buildReviewTask(repo, diffFromGit(repo));
        expect(task.items.map(i => i.function)).toEqual(['syncOrders']);
        expect(task.items[0].questions[0]).toMatch(/concurrent calls/);
        expect(task.items[0].questions.at(-1)).toContain('`syncOrders`');
    });

    it('sends a function a verified team lesson names to review, and asks whether the change repeats it', () => {
        write(AFTER.replace('name.trim()', 'name.toLocaleUpperCase()'));
        seedLessons(repo, [{ id: 'l1', text: 'Locale casing breaks Turkish names.', file: 'sync.ts', symbols: ['toLocaleUpperCase'], state: 'verified', evidence: [{ pr: 7, comment: 'c1', author: 'r' }], createdAt: '', updatedAt: '' }]);
        const task = buildReviewTask(repo, diffFromGit(repo));
        const label = task.items.find(i => i.function === 'label');
        expect(label?.questions[0]).toContain('Locale casing breaks Turkish names.');
        expect(buildReviewTask(repo, diffFromGit(repo), {}, 'off').items.map(i => i.function)).toEqual(['syncOrders']);
    });

    it('drops an acknowledged function from the task until its code changes again', () => {
        const ack = acknowledgeReview(repo, { file: 'sync.ts', function: 'syncOrders', verdict: 'no_issue', note: 'upsert key is the unique order id; callers retry safely' });
        expect(ack.ok).toBe(true);
        expect(buildReviewTask(repo, diffFromGit(repo))).toMatchObject({ items: [], alreadyReviewed: 1 });

        write(AFTER.replace('return rows;', 'return rows.slice(1);'));
        expect(buildReviewTask(repo, diffFromGit(repo)).items.map(i => i.function)).toEqual(['syncOrders']);
    });

    it('refuses an acknowledgement without a real note, a known verdict, or a real function', () => {
        expect(acknowledgeReview(repo, { file: 'sync.ts', function: 'syncOrders', verdict: 'no_issue', note: 'ok' })).toMatchObject({ ok: false });
        expect(acknowledgeReview(repo, { file: 'sync.ts', function: 'syncOrders', verdict: 'lgtm', note: 'looked at it carefully' })).toMatchObject({ ok: false });
        expect(acknowledgeReview(repo, { file: 'sync.ts', function: 'nope', verdict: 'fixed', note: 'looked at it carefully' })).toMatchObject({ ok: false });
        expect(readLedger(repo)).toEqual([]);
    });

    it('exports hashes and verdicts only, and a committed export clears the task too', () => {
        acknowledgeReview(repo, { file: 'sync.ts', function: 'syncOrders', verdict: 'fixed', note: 'made the upsert key explicit' });
        exportReviewed(repo);
        const exported = JSON.parse(fs.readFileSync(path.join(repo, REVIEWED_FILE), 'utf8'));
        expect(Object.keys(exported.entries[0]).sort()).toEqual(['file', 'function', 'hash', 'reviewer', 'verdict']);

        fs.rmSync(path.join(repo, '.rigour', 'review-ledger.jsonl'));
        expect(buildReviewTask(repo, diffFromGit(repo)).items).toEqual([]);
    });

    it('tells a stopping agent which functions still need review, and how', () => {
        const message = reviewAckMessage(buildReviewTask(repo, diffFromGit(repo)).items, 1);
        expect(message).toContain('sync.ts:1 `syncOrders`');
        expect(message).toContain('rigour_review_ack');
    });
});
