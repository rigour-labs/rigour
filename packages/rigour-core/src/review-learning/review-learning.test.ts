import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { actedOn, gitIn } from './acted-on.js';
import { learnFromReviews } from './learn-from-reviews.js';
import { lessonText, matchLessons, mergeLessons, readLessons, type ReviewLesson } from './lessons.js';
import { lessonsForDiff, lessonsSection } from './team-lessons.js';

let repo: string;
const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
const write = (body: string) => fs.writeFileSync(path.join(repo, 'src/orders.ts'), body);
const commit = (message: string) => { git('add', '-A'); git('commit', '-qm', message); return git('rev-parse', 'HEAD'); };

const V1 = 'export async function save(db, order) {\n  await db.insert(order);\n  return order.id;\n}\n';
const V2 = 'export async function save(db, order) {\n  await db.upsert(order, { onConflict: "id" });\n  return order.id;\n}\n';

beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'review-learning-'));
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 't');
    git('config', 'commit.gpgsign', 'false');
    fs.mkdirSync(path.join(repo, 'src'));
});
afterEach(() => { fs.rmSync(repo, { recursive: true, force: true }); });

const comment = (id: string, sha: string, start: number, body: string, prNumber = 7) => ({ id, prNumber, path: 'src/orders.ts', start, end: start, commit: sha, body, author: 'reviewer' });

describe('actedOn', () => {
    it('keeps a comment whose lines changed before merge, and drops one nobody acted on', () => {
        write(V1);
        const reviewed = commit('pr head');
        write(V2);
        const merged = commit('address review');
        const acted = actedOn(gitIn(repo), { number: 7, mergeSha: merged, mergedAt: '', comments: [
            comment('a', reviewed, 2, '**Use an upsert keyed on `id` so a retry does not duplicate the order.**'),
            comment('b', reviewed, 3, 'Nit: return the whole order?'),
        ] });
        expect(acted.map(c => c.id)).toEqual(['a']);
    });
});

describe('lessons', () => {
    it('keeps the point of a review comment and drops tool output and markup', () => {
        const body = '_⚠️ Potential issue_ | _🟠 Major_\n\n**Use an upsert keyed on `id`.**\n\n<details>\n<summary>🏁 Script executed</summary>\nrg -n insert\n</details>';
        expect(lessonText(body)).toBe('Use an upsert keyed on `id`.');
        expect(lessonText('Callers retry on timeout, so this insert duplicates orders. Please use upsert.')).toBe('Callers retry on timeout, so this insert duplicates orders.');
    });

    it('verifies a lesson only when it was acted on in two PRs', () => {
        const lesson = (pr: number, comment: string): ReviewLesson => ({
            id: 'x', text: 'Use upsert', file: 'src/orders.ts', symbols: ['save', 'insert'], state: 'candidate',
            evidence: [{ pr, comment, author: 'r' }], createdAt: '', updatedAt: '',
        });
        const once = mergeLessons([], [lesson(1, 'c1'), lesson(1, 'c2')]);
        expect(once.lessons[0].state).toBe('candidate');
        const twice = mergeLessons(once.lessons, [lesson(2, 'c3')]);
        expect(twice).toMatchObject({ added: 0, verified: 1 });
        expect(twice.lessons[0].evidence).toHaveLength(3);
    });

    it('matches lessons by file, symbols and directory, verified only unless asked', () => {
        const base = { symbols: ['insert'], evidence: [{ pr: 1, comment: 'c', author: 'r' }], createdAt: '', updatedAt: '' };
        const lessons: ReviewLesson[] = [
            { ...base, id: '1', text: 'same file', file: 'src/orders.ts', state: 'verified' },
            { ...base, id: '2', text: 'other dir, two shared symbols', file: 'lib/x.ts', state: 'verified', symbols: ['insert', 'orderId'] },
            { ...base, id: '5', text: 'other dir, one generic shared symbol', file: 'lib/z.ts', state: 'verified' },
            { ...base, id: '3', text: 'candidate', file: 'src/orders.ts', state: 'candidate' },
            { ...base, id: '4', text: 'unrelated', file: 'lib/y.ts', state: 'verified', symbols: ['other'] },
        ];
        const change = { files: ['src/orders.ts'], symbols: new Set(['insert', 'orderId']) };
        expect(matchLessons(lessons, change).map(l => l.id)).toEqual(['1', '2']);
        expect(matchLessons(lessons, change, { includeCandidates: true }).map(l => l.id)).toEqual(['1', '3', '2']);
    });
});

describe('learnFromReviews', () => {
    it('reads merged PRs from GitHub, learns from acted-on comments, and shows them for the next change', async () => {
        write(V1);
        const reviewed = commit('pr head');
        write(V2);
        const merged = commit('address review');
        const api = 'https://api.github.com/repos/acme/app';
        const pages: Record<string, unknown> = {
            [`${api}/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=1`]: [
                { number: 7, merged_at: '2026-09-01T00:00:00Z', merge_commit_sha: merged },
                { number: 8, merged_at: null, merge_commit_sha: null },
            ],
            [`${api}/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=2`]: [],
            [`${api}/pulls/7/comments?per_page=100`]: [
                { id: 11, path: 'src/orders.ts', original_line: 2, original_commit_id: reviewed, body: '**Use an upsert keyed on `id` so retries do not duplicate orders.**', user: { login: 'priya' } },
                { id: 12, path: 'src/orders.ts', original_line: 2, original_commit_id: reviewed, body: 'agreed', in_reply_to_id: 11, user: { login: 'sam' } },
            ],
        };
        const fetchImpl = async (url: string) => ({ ok: url in pages, status: url in pages ? 200 : 404, json: async () => pages[url] });
        const result = await learnFromReviews(repo, { token: 't', repo: 'acme/app', fetch: fetchImpl });
        expect(result).toMatchObject({ prs: 1, comments: 1, actedOn: 1, added: 1, total: 1 });
        expect(readLessons(repo)[0]).toMatchObject({ file: 'src/orders.ts', text: 'Use an upsert keyed on `id` so retries do not duplicate orders.', evidence: [{ pr: 7, author: 'priya' }] });

        const diff = '+++ b/src/orders.ts\n@@ -1,0 +1,1 @@\n+  await db.insert(other);\n';
        expect(lessonsForDiff(repo, diff, 'verified')).toEqual([]); // one PR is not enough to verify
        expect(lessonsSection(lessonsForDiff(repo, diff, 'all'))).toContain('src/orders.ts: Use an upsert keyed on `id` so retries do not duplicate orders. (acted on in PR #7)');
    });
});
