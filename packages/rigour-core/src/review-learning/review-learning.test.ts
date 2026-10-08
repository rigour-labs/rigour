import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gitIn, withActedOn } from './acted-on.js';
import { learnFromReviews } from './learn-from-reviews.js';
import { outcomeFor } from './outcomes.js';
import { rulesFromReviews } from './rules-from-reviews.js';
import { describeLesson, lessonView } from './team-lessons.js';
import { decideLesson, isSpecific, lessonState, lessonText, matchLessons, mergeLessons, readLessons, writeLessons, type LessonEvidence, type ReviewLesson } from './lessons.js';
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

describe('acted on', () => {
    it('marks a comment whose lines changed before merge, and one nobody acted on, keeping both', () => {
        write(V1);
        const reviewed = commit('pr head');
        write(V2);
        const merged = commit('address review');
        const marked = withActedOn(gitIn(repo), { number: 7, mergeSha: merged, mergedAt: '', comments: [
            comment('a', reviewed, 2, '**Use an upsert keyed on `id` so a retry does not duplicate the order.**'),
            comment('b', reviewed, 3, 'Nit: return the whole order?'),
        ], reviews: [] });
        expect(marked.map(c => [c.id, c.actedOn])).toEqual([['a', true], ['b', false]]);
    });
});

describe('lessons', () => {
    it('keeps the point of a review comment and drops tool output and markup', () => {
        const body = '_⚠️ Potential issue_ | _🟠 Major_\n\n**Use an upsert keyed on `id`.**\n\n<details>\n<summary>🏁 Script executed</summary>\nrg -n insert\n</details>';
        expect(lessonText(body)).toBe('Use an upsert keyed on `id`.');
        expect(lessonText('Callers retry on timeout, so this insert duplicates orders. Please use upsert.')).toBe('Callers retry on timeout, so this insert duplicates orders.');
        expect(lessonText('### Medium Severity\n\nThe retry loop never resets `attempt`, so a second failure gives up at once.')).toBe('The retry loop never resets `attempt`, so a second failure gives up at once.');
    });

    it('makes a candidate a lesson only on evidence, and keeps every piece of it', () => {
        const point = (pr: number, prAuthor: string, source: 'person' | 'bot' = 'person', reviewer = `reviewer-of-${pr}`): LessonEvidence => ({ kind: 'point', pr, comment: `c${pr}${prAuthor}`, author: reviewer, source, prAuthor });
        const lesson = (...evidence: LessonEvidence[]): ReviewLesson => ({ id: 'x', text: 'Use upsert', file: 'src/orders.ts', symbols: [], state: 'candidate', evidence, createdAt: '', updatedAt: '' });
        expect(lessonState(lesson(point(1, 'ann')))).toEqual({ state: 'candidate' });
        expect(lessonState(lesson(point(1, 'ann'), point(2, 'ann')))).toEqual({ state: 'candidate' }); // two PRs, one author: weak, not enough
        expect(lessonState(lesson(point(1, 'ann'), point(2, 'bob', 'bot')))).toEqual({ state: 'verified', promotedBy: 'recurrence' }); // a bot's point counts the same
        const said = (e: LessonEvidence, text: string): LessonEvidence => ({ ...e, text });
        expect(lessonState(lesson(said(point(1, 'ann', 'bot', 'helper[bot]'), 'Consider more tests.'), said(point(2, 'bob', 'bot', 'helper[bot]'), 'Consider more tests.')))).toEqual({ state: 'candidate' }); // one bot's template on every PR is one source
        expect(lessonState(lesson(said(point(1, 'ann', 'person', 'lead'), 'Regenerate the API client after changing the schema.'), said(point(2, 'bob', 'person', 'lead'), 'The generated client is stale again.')))).toEqual({ state: 'verified', promotedBy: 'recurrence' }); // a senior re-raising it in their own words
        expect(lessonState(lesson(point(1, 'ann'), point(2, 'bob'), { kind: 'norule', pr: 1, comment: 'n', author: '' }))).toEqual({ state: 'candidate' }); // no rule in it: never promoted again
        const outcome: LessonEvidence = { kind: 'outcome', pr: 1, comment: 'o', author: '', detail: 'fixed later by abc' };
        const counter: LessonEvidence = { kind: 'counter', pr: 1, comment: 'k', author: '', detail: 'unchanged 40 days' };
        expect(lessonState(lesson(point(1, 'ann', 'bot'), outcome))).toEqual({ state: 'verified', promotedBy: 'outcome' });
        expect(lessonState(lesson(point(1, 'ann'), point(2, 'bob'), counter))).toEqual({ state: 'candidate' }); // counter-evidence holds recurrence back
        const accepted: LessonEvidence = { kind: 'accepted', pr: 1, comment: 'y', author: 'lead@x' };
        const rejected: LessonEvidence = { kind: 'rejected', pr: 1, comment: 'n', author: 'lead@x' };
        expect(lessonState(lesson(point(1, 'ann'), outcome, rejected))).toEqual({ state: 'rejected' }); // a person's decision wins
        expect(lessonState(lesson(point(1, 'ann'), rejected, accepted))).toEqual({ state: 'verified', promotedBy: 'person' }); // the latest decision
        expect(lessonState({ ...lesson({ pr: 1, comment: 'old', author: 'r' }), state: 'verified' })).toEqual({ state: 'verified', promotedBy: 'legacy' }); // a record from before evidence keeps its state
    });

    it('records a person accepting or rejecting a lesson as evidence, with who and why', () => {
        writeLessons(repo, [{ id: 'x', text: 'Use upsert', file: 'src/orders.ts', symbols: [], state: 'candidate', evidence: [{ kind: 'point', pr: 1, comment: 'c', author: 'r' }], createdAt: '', updatedAt: '' }]);
        expect(decideLesson(repo, 'x', 'rejected', 'lead@x', 'we accept duplicates here')).toMatchObject({ state: 'rejected' });
        expect(readLessons(repo)[0].evidence.at(-1)).toMatchObject({ kind: 'rejected', author: 'lead@x', detail: 'we accept duplicates here' });
        expect(matchLessons(readLessons(repo), { files: ['src/orders.ts'], symbols: new Set() }, { includeCandidates: true })).toEqual([]); // never served as a lesson
        expect(decideLesson(repo, 'nope', 'accepted', 'lead@x')).toBeUndefined();
    });

    it('matches lessons by file, symbols and directory, verified only unless asked', () => {
        const base = { symbols: ['insert'], evidence: [{ pr: 1, comment: 'c', author: 'r' }], createdAt: '', updatedAt: '' };
        const lessons: ReviewLesson[] = [
            { ...base, id: '1', text: 'same file', file: 'src/orders.ts', state: 'verified' },
            { ...base, id: '2', text: 'other dir, two shared symbols', file: 'lib/x.ts', state: 'verified', symbols: ['insertOrder', 'orderId'] },
            { ...base, id: '6', text: 'a lesson about a runbook', file: 'docs/runbook.md', state: 'verified', symbols: ['insertOrder', 'orderId'] },
            { ...base, id: '5', text: 'other dir, one generic shared symbol', file: 'lib/z.ts', state: 'verified' },
            { ...base, id: '3', text: 'candidate', file: 'src/orders.ts', state: 'candidate' },
            { ...base, id: '4', text: 'unrelated', file: 'lib/y.ts', state: 'verified', symbols: ['other'] },
        ];
        const change = { files: ['src/orders.ts'], symbols: new Set(['insert', 'insertOrder', 'orderId']) };
        expect(matchLessons(lessons, change).map(l => l.id)).toEqual(['2', '1']); // two specific shared names outrank a same-file lesson with only generic ones
        expect(matchLessons(lessons, change, { includeCandidates: true }).map(l => l.id)).toEqual(['2', '1', '3']);
    });
});

describe('learning from one pull request as it goes', () => {
    it('reads its reviews up to a time, and counts a point acted on by the head as of then', async () => {
        write(V1);
        const reviewed = commit('pr head');
        write(V2);
        const fixed = commit('address review');
        const api = 'https://api.github.com/repos/acme/app';
        const pages: Record<string, unknown> = {
            [`${api}/pulls/42`]: { number: 42, user: { login: 'dev' }, head: { sha: fixed } },
            [`${api}/pulls/42/commits?per_page=100&page=1`]: [
                { sha: reviewed, commit: { committer: { date: '2026-09-01T00:00:00Z' } } },
                { sha: fixed, commit: { committer: { date: '2026-09-02T00:00:00Z' } } },
            ],
            [`${api}/pulls/42/comments?per_page=100&page=1`]: [],
            [`${api}/pulls/42/reviews?per_page=100&page=1`]: [
                { id: 1, commit_id: reviewed, submitted_at: '2026-09-01T12:00:00Z', user: { login: 'priya' }, body: '- In src/orders.ts make the insert idempotent on retry.' },
                { id: 2, commit_id: fixed, submitted_at: '2026-09-06T00:00:00Z', user: { login: 'priya' }, body: '- A later point the learner must not see yet.' },
            ],
        };
        const fetchImpl = async (url: string) => ({ ok: url in pages, status: url in pages ? 200 : 404, json: async () => pages[url] });
        const early = await learnFromReviews(repo, { token: 't', repo: 'acme/app', fetch: fetchImpl, pr: 42, until: '2026-09-01T18:00:00Z' });
        expect(early).toMatchObject({ prs: 1, reviewBodies: 1, total: 1 }); // the later review is not seen yet
        expect(readLessons(repo)[0]).toMatchObject({ file: 'src/orders.ts', text: 'In src/orders.ts make the insert idempotent on retry.', evidence: [{ pr: 42, author: 'priya', actedOn: false }] });
        fs.rmSync(path.join(repo, '.rigour', 'review-lessons.json'));
        await learnFromReviews(repo, { token: 't', repo: 'acme/app', fetch: fetchImpl, pr: 42, until: '2026-09-03T00:00:00Z' });
        expect(readLessons(repo)[0].evidence[0]).toMatchObject({ actedOn: true }); // the fix landed before this cut
    });
});

describe('outcome evidence from git', () => {
    it('finds a later fix to the lines a point named, counts lines left alone against it, and never looks past the cut', () => {
        write('export function total(order) {\n  return order.items.length;\n}\n');
        commit('base');
        git('checkout', '-qb', 'feature');
        write('export function total(order) {\n  const n = order.items.length;\n  return n;\n}\n');
        const reviewed = commit('pr head');
        git('checkout', '-q', 'main');
        git('merge', '-q', '--no-ff', '--no-edit', 'feature');
        const merge = git('rev-parse', 'HEAD');
        write('// header\nexport function total(order) {\n  const n = order.items?.length ?? 0;\n  return n;\n}\n');
        execFileSync('git', ['-C', repo, 'commit', '-qam', 'fix: total crashes on an order with no items'], { env: { ...process.env, GIT_COMMITTER_DATE: '2026-09-20T00:00:00Z' } });
        const point = (start: number, actedOn = false): ReviewLesson => ({ id: `p${start}`, text: 'Guard a missing items list.', file: 'src/orders.ts', symbols: [], state: 'candidate', at: { commit: reviewed, start, end: start }, evidence: [{ kind: 'point', pr: 7, comment: `c${start}`, author: 'bot', source: 'bot', actedOn }], createdAt: '', updatedAt: '' });
        const pr = { number: 7, mergeSha: merge, mergedAt: '2026-09-01T00:00:00Z' };
        const later = outcomeFor(gitIn(repo), point(2), pr, { mainRef: 'main' });
        expect(later).toMatchObject({ kind: 'outcome', detail: expect.stringContaining('fix: total crashes on an order with no items') });
        expect(outcomeFor(gitIn(repo), point(2), pr, { mainRef: 'main', until: '2026-09-10T00:00:00Z' })).toBeUndefined(); // before the fix, within the window: no verdict yet
        expect(outcomeFor(gitIn(repo), point(3), pr, { mainRef: 'main' })).toMatchObject({ kind: 'counter' }); // `return n;` shipped and stayed, past the window
        expect(outcomeFor(gitIn(repo), point(2, true), pr, { mainRef: 'main' })).toBeUndefined(); // acted on in the PR: no outcome to read
    });
});

describe('team standards', () => {
    it('verifies a standard when the same point recurs in another author\'s PR, and serves it only to a change it is about', () => {
        const standard = (pr: number, text: string): ReviewLesson => ({ id: `s${pr}`, text, file: '', symbols: [], state: 'candidate', evidence: [{ kind: 'point', pr, comment: `r${pr}`, author: `reviewer${pr}`, prAuthor: `dev${pr}` }], createdAt: '', updatedAt: '' });
        const merged = mergeLessons([], [standard(1, 'Bound both ends of every time window a job reads.'), standard(2, 'Bound both ends of the time window this job reads.')]);
        expect(merged.lessons).toHaveLength(1);
        expect(merged.lessons[0].state).toBe('verified');
        const unrelated = mergeLessons(merged.lessons, [standard(3, 'Log the request id on every error.')]);
        expect(unrelated.lessons).toHaveLength(2);
        expect(matchLessons(unrelated.lessons, { files: ['src/jobs/scan.ts'], symbols: new Set(['timeWindowStart', 'readRows']) }).map(l => l.text)).toEqual(['Bound both ends of every time window a job reads.']);
        expect(matchLessons(unrelated.lessons, { files: ['src/ui/Dialog.svelte'], symbols: new Set(['onKeydown']) })).toEqual([]); // nothing in common: not served
    });
});

describe('turning reviews into rules', () => {
    const point = (id: string, text: string, file = ''): ReviewLesson => ({ id, text, file, symbols: [], state: 'candidate', evidence: [{ pr: 7, comment: `c-${id}`, author: 'priya' }], createdAt: '', updatedAt: '' });

    it('keeps the rule behind a point, drops a status note, keeps an unanswered point as said, and keeps the words beside the rule', async () => {
        const prompts: string[] = [];
        const write = async (prompt: string) => {
            prompts.push(prompt);
            return 'Here you go:\n{"rules":[{"id":"a","rule":"Apply discounts before computing an invoice total.","file":null},{"id":"b","rule":null,"file":null}]}';
        };
        const points = [point('a', 'The invoice total is computed before the discount is applied.'), point('b', 'npm run check: 0 errors, lint clean.'), point('c', 'A retry posts the payment twice.')];
        const out = await rulesFromReviews(points, write);
        expect(out).toMatchObject({ rules: 1, dropped: 1, unanswered: 1 });
        expect(out.lessons.map(l => [l.text, l.evidence.at(-1)?.kind])).toEqual([
            ['Apply discounts before computing an invoice total.', undefined], ['npm run check: 0 errors, lint clean.', 'norule'], ['A retry posts the payment twice.', undefined],
        ]); // the no-rule point is kept and marked, never sent again
        expect(out.lessons[0].evidence[0].said).toBe('The invoice total is computed before the discount is applied.');
        expect(prompts[0]).toContain('"said": "npm run check: 0 errors, lint clean."');
        expect(describeLesson(lessonView({ ...out.lessons[0], evidence: [...out.lessons[0].evidence, { pr: 9, comment: 'x', author: 'sam' }] })))
            .toBe('team standard: Apply discounts before computing an invoice total. (in their words: "The invoice total is computed before the discount is applied.") (acted on in PR #7, #9)');
    });

    it('never loses a point when the model cannot run, and keeps a file only when the point was about it', async () => {
        const out = await rulesFromReviews([point('a', 'In src/run.ts the flag is read last.', 'src/run.ts')], async () => undefined);
        expect(out.lessons.map(l => [l.text, l.file])).toEqual([['In src/run.ts the flag is read last.', 'src/run.ts']]);
        const moved = await rulesFromReviews([point('a', 'A point about one place.', 'src/a.ts')], async () => '{"rules":[{"id":"a","rule":"A rule the model placed in another file.","file":"src/b.ts"}]}');
        expect(moved.lessons[0].file).toBe('');
    });
});

describe('isSpecific', () => {
    it('counts identifiers that name something, not common words', () => {
        expect(['orderId', 'max_rows', 'renderTransactionalMessage'].map(isSpecific)).toEqual([true, true, true]);
        expect(['data', 'error', 'route', 'insert'].map(isSpecific)).toEqual([false, false, false, false]);
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
                { number: 7, merged_at: '2026-09-01T00:00:00Z', merge_commit_sha: merged, user: { login: 'dev' } },
                { number: 8, merged_at: null, merge_commit_sha: null },
            ],
            [`${api}/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=2`]: [],
            [`${api}/pulls/7/comments?per_page=100`]: [
                { id: 11, path: 'src/orders.ts', original_line: 2, original_commit_id: reviewed, body: '**Use an upsert keyed on `id` so retries do not duplicate orders.**', user: { login: 'priya' } },
                { id: 12, path: 'src/orders.ts', original_line: 2, original_commit_id: reviewed, body: 'agreed', in_reply_to_id: 11, user: { login: 'sam' } },
                { id: 13, path: 'src/orders.ts', original_line: 2, original_commit_id: reviewed, body: '**Rename the variable to orderRow for clarity.**', user: { login: 'review-helper[bot]', type: 'Bot' } },
                { id: 14, path: 'src/orders.ts', original_line: 2, original_commit_id: reviewed, body: '**Self note: tidy this later.**', user: { login: 'dev' } },
            ],
            [`${api}/pulls/7/reviews?per_page=100`]: [
                { id: 21, commit_id: reviewed, user: { login: 'priya' }, body: '## Review\n\n- Bound both ends of every time window a scheduled job reads.\n- In src/orders.ts the insert needs the idempotency key.\nThanks!' },
                { id: 22, commit_id: reviewed, user: { login: 'review-helper[bot]', type: 'Bot' }, body: '- Consider adding more unit tests for orders.' },
                { id: 23, commit_id: reviewed, user: { login: 'dev' }, body: '- Addressed every point in the next commit.' },
            ],
        };
        const fetchImpl = async (url: string) => ({ ok: url in pages, status: url in pages ? 200 : 404, json: async () => pages[url] });
        const result = await learnFromReviews(repo, { token: 't', repo: 'acme/app', fetch: fetchImpl });
        // Every point is a candidate, the bot's too; the author's own comments are not review points.
        expect(result).toMatchObject({ prs: 1, comments: 2, actedOn: 2, reviewBodies: 2, candidates: { person: 3, bot: 2 }, verified: 0 });
        const lessons = readLessons(repo);
        expect(lessons.every(l => l.state === 'candidate')).toBe(true); // nothing is a lesson without evidence
        const sources = new Set(lessons.flatMap(l => l.evidence.map(e => `${e.author}/${e.source}/${e.prAuthor}`)));
        expect([...sources].sort()).toEqual(['priya/person/dev', 'review-helper[bot]/bot/dev']);
        expect(lessons.map(l => l.text)).toEqual(expect.arrayContaining(['Bound both ends of every time window a scheduled job reads.', 'Consider adding more unit tests for orders.']));

        const diff = '+++ b/src/orders.ts\n@@ -1,0 +1,1 @@\n+  await db.insert(other);\n';
        expect(lessonsForDiff(repo, diff, 'verified')).toEqual([]); // candidates are not served by default
        expect(lessonsSection(lessonsForDiff(repo, diff, 'all'))).toContain('src/orders.ts: Use an upsert keyed on `id` so retries do not duplicate orders.');

        const again = await learnFromReviews(repo, { token: 't', repo: 'acme/app', fetch: fetchImpl, writeRules: async () => { throw new Error('nothing promoted: no rule is written'); } });
        expect(again).toMatchObject({ added: 0, total: lessons.length });
        const upsert = lessons.find(l => l.text.startsWith('Use an upsert'))!;
        decideLesson(repo, upsert.id, 'accepted', 'lead@acme');
        const ruled = await learnFromReviews(repo, { token: 't', repo: 'acme/app', fetch: fetchImpl, writeRules: async prompt => JSON.stringify({ rules: [...prompt.matchAll(/"id": "(\w+)"/g)].map(m => ({ id: m[1], rule: 'Make every write idempotent on retry.', file: 'src/orders.ts' })) }) });
        expect(ruled).toMatchObject({ rules: 1, notRules: 0, promoted: { person: 1 } }); // written only for the promoted lesson
        expect(readLessons(repo).find(l => l.state === 'verified')).toMatchObject({ text: 'Make every write idempotent on retry.', promotedBy: 'person' });
        const audit = fs.readFileSync(path.join(repo, '.rigour', 'review-rules-log.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
        expect(audit.map(a => [a.said, a.rule])).toEqual([[upsert.text, 'Make every write idempotent on retry.']]);
    });
});
