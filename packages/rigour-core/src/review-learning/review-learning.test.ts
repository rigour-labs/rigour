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
import { acceptSuggestedText, decideLesson, isSpecific, lessonState, lessonText, lessonsFromReview, matchLessons, mergeLessons, pendingDecision, quietBotCandidate, raisedOnlyByBots, readLessons, writeLessons, type LessonEvidence, type ReviewLesson } from './lessons.js';
import { activeLessons, lessonsForDiff, lessonsSection } from './team-lessons.js';

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
    it('never makes a lesson of a bare path or a review bot\'s line-range scaffolding', () => {
        expect(lessonText('src/routes/account/+layout.ts')).toBe('');
        expect(lessonText('`src/routes/account/api/[planId]/+server.ts`')).toBe('');
        expect(lessonText('In src/a.ts around lines 10-12: Check the lock before the first read.')).toBe('Check the lock before the first read.');
        expect(lessonText('Around line 124-141: Add a test for the failed save.')).toBe('Add a test for the failed save.');
        expect(lessonsFromReview({ id: '1', prNumber: 3, commit: 'c', author: 'rabbit[bot]', source: 'bot', body: '- `src/a/b.ts`\n- Bound both ends of the time window.' }, ['src/a/b.ts']).map(l => l.text))
            .toEqual(['Bound both ends of the time window.']);
    });

    it('keeps the point of a review comment and drops tool output and markup', () => {
        const body = '_⚠️ Potential issue_ | _🟠 Major_\n\n**Use an upsert keyed on `id`.**\n\n<details>\n<summary>🏁 Script executed</summary>\nrg -n insert\n</details>';
        expect(lessonText(body)).toBe('Use an upsert keyed on `id`.');
        expect(lessonText('Callers retry on timeout, so this insert duplicates orders. Please use upsert.')).toBe('Callers retry on timeout, so this insert duplicates orders. Please use upsert.');
        expect(lessonText('### Medium Severity\n\nThe retry loop never resets `attempt`, so a second failure gives up at once.')).toBe('The retry loop never resets `attempt`, so a second failure gives up at once.');
    });

    it('keeps what the reviewer asked for, not only what was wrong, and an identifier as written', () => {
        expect(lessonText('`config.tenant` is a nested config object and it carries `apiKey`. Pick the fields you need explicitly. It also goes to the response.'))
            .toBe('`config.tenant` is a nested config object and it carries `apiKey`. Pick the fields you need explicitly.');
        expect(lessonText('Never log `config.tenant` whole. It carries the key.')).toBe('Never log `config.tenant` whole.'); // already an instruction
        expect(lessonText('RESTOCK_CHUNK mirrors restock_batch_size, so raising one leaves the other stale. Change them together.'))
            .toBe('RESTOCK_CHUNK mirrors restock_batch_size, so raising one leaves the other stale. Change them together.');
        expect(lessonText('The _second_ read of `invoice_lines` is __the same rows__ as the first.')).toBe('The second read of `invoice_lines` is the same rows as the first.');
        expect(lessonsFromReview({ id: 9, prNumber: 4, author: 'r', body: '- `MAX_LABELS_PER_CALL` must follow `labels_per_request`.', submittedAt: '', commit: 'c' } as any, [])[0].text)
            .toBe('`MAX_LABELS_PER_CALL` must follow `labels_per_request`.');
    });

    it('reads the same review comment again as the same lesson: an undecided one takes the new text, nothing is duplicated', () => {
        // A different text gets a different id, as the real hash does.
        const point = (text: string, pr = 1, comment = 'c1'): ReviewLesson => ({ id: `id-${text.length}`, text, file: 'src/a.ts', symbols: ['loadRows', 'status'], state: 'candidate', evidence: [{ kind: 'point', pr, comment, author: 'r', text, at: '' }], createdAt: '', updatedAt: '' });
        const stored = mergeLessons([], [point('This reads every row.')]).lessons;
        const again = mergeLessons(stored, [point('This reads every row. Filter in the query.')]);
        expect(again.added).toBe(0);
        expect(again.lessons.map(l => [l.id, l.text, l.state, l.suggestedText])).toEqual([[stored[0].id, 'This reads every row. Filter in the query.', 'candidate', undefined]]);
        const twice = mergeLessons(again.lessons, [point('This reads every row. Filter in the query.')]);
        expect(twice.lessons).toEqual(again.lessons.map(l => ({ ...l, updatedAt: twice.lessons[0].updatedAt })));
        const later = mergeLessons(again.lessons, [point('Same scan here, filter it in SQL.', 2, 'c9')]);
        expect(later.lessons[0].text).toBe('This reads every row. Filter in the query.'); // another comment adds evidence, never rewrites
    });

    it('never rewrites a lesson a person decided: the new wording waits for them, and taking it is recorded', () => {
        const point = (text: string): ReviewLesson => ({ id: `id-${text.length}`, text, file: 'src/a.ts', symbols: ['loadRows', 'status'], state: 'candidate', evidence: [{ kind: 'point', pr: 1, comment: 'c1', author: 'r', text, at: '' }], createdAt: '', updatedAt: '' });
        for (const decision of ['accepted', 'rejected', 'dismissed', 'compiled'] as const) {
            const stored = mergeLessons([], [point('This reads every row.')]).lessons;
            stored[0].evidence.push({ kind: decision, pr: 1, comment: `${decision}-1`, author: 'p@example.com', detail: 'decided', at: '' });
            const again = mergeLessons(stored, [point('This reads every row. Filter in the query.')]);
            expect(again.lessons.map(l => [l.text, l.suggestedText, l.suggestedWhy])).toEqual([['This reads every row.', 'This reads every row. Filter in the query.', 'parser fix']]);
            expect(mergeLessons(again.lessons, [point('This reads every row. Filter in the query.')]).lessons.map(l => [l.text, l.suggestedText])).toEqual([['This reads every row.', 'This reads every row. Filter in the query.']]);
        }
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reworded-'));
        try {
            const stored = mergeLessons([], [point('This reads every row.')]).lessons;
            stored[0].evidence.push({ kind: 'accepted', pr: 1, comment: 'accepted-1', author: 'p@example.com', at: '' });
            writeLessons(dir, mergeLessons(stored, [point('This reads every row. Filter in the query.')]).lessons);
            const taken = acceptSuggestedText(dir, stored[0].id, 'p@example.com');
            expect([taken?.text, taken?.suggestedText, taken?.state]).toEqual(['This reads every row. Filter in the query.', undefined, 'verified']);
            expect(taken?.evidence.at(-1)).toMatchObject({ kind: 'reworded', author: 'p@example.com', detail: 'parser fix; was: This reads every row.' });
            const reread = mergeLessons(readLessons(dir), [point('This reads every row. Filter in the query.')]).lessons;
            expect([reread[0].text, reread[0].suggestedText]).toEqual(['This reads every row. Filter in the query.', undefined]); // nothing left to suggest
            expect(acceptSuggestedText(dir, stored[0].id, 'p@example.com')).toBeUndefined();
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('makes a candidate a lesson only on evidence, and keeps every piece of it', () => {
        const point = (pr: number, prAuthor: string, source: 'person' | 'bot' = 'person', reviewer = `reviewer-of-${pr}`): LessonEvidence => ({ kind: 'point', pr, comment: `c${pr}${prAuthor}`, author: reviewer, source, prAuthor });
        const lesson = (...evidence: LessonEvidence[]): ReviewLesson => ({ id: 'x', text: 'Use upsert', file: 'src/orders.ts', symbols: [], state: 'candidate', evidence, createdAt: '', updatedAt: '' });
        expect(lessonState(lesson(point(1, 'ann')))).toEqual({ state: 'candidate' });
        expect(lessonState(lesson(point(1, 'ann'), point(2, 'ann')))).toEqual({ state: 'candidate' }); // two PRs, one author: weak, not enough
        expect(lessonState(lesson(point(1, 'ann'), point(2, 'bob', 'bot')))).toEqual({ state: 'verified', promotedBy: 'recurrence' }); // a bot's point counts the same
        expect(lessonState(lesson(point(1, 'ann', 'bot', 'rabbit[bot]'), point(2, 'bob', 'bot', 'helper[bot]')))).toEqual({ state: 'candidate' }); // two bots agreeing, no person: never verified
        const said = (e: LessonEvidence, text: string): LessonEvidence => ({ ...e, text });
        expect(lessonState(lesson(said(point(1, 'ann', 'bot', 'helper[bot]'), 'Around line 60-103: update the callers.'), said(point(2, 'bob', 'bot', 'helper[bot]'), 'Around line 12-14: update the loader.')))).toEqual({ state: 'candidate' }); // a bot rewording its own point is one source
        expect(lessonState(lesson(said(point(1, 'ann', 'bot', 'helper[bot]'), 'Consider more tests.'), said(point(2, 'bob', 'bot', 'helper[bot]'), 'Consider more tests.')))).toEqual({ state: 'candidate' }); // one bot's template on every PR is one source
        expect(lessonState(lesson(said(point(1, 'ann', 'person', 'lead'), 'Regenerate the API client after changing the schema.'), said(point(2, 'bob', 'person', 'lead'), 'The generated client is stale again.')))).toEqual({ state: 'verified', promotedBy: 'recurrence' }); // a senior re-raising it in their own words
        expect(lessonState(lesson(point(1, 'ann'), point(2, 'bob'), { kind: 'norule', pr: 1, comment: 'n', author: '' }))).toEqual({ state: 'candidate' }); // no rule in it: never promoted again
        const outcome: LessonEvidence = { kind: 'outcome', pr: 1, comment: 'o', author: '', detail: 'fixed later by abc' };
        const counter: LessonEvidence = { kind: 'counter', pr: 1, comment: 'k', author: '', detail: 'unchanged 40 days' };
        expect(lessonState(lesson(point(1, 'ann', 'bot'), outcome))).toEqual({ state: 'candidate' }); // an outcome is evidence for a person, never a promotion
        expect(lessonState(lesson(point(1, 'ann'), point(2, 'bob'), counter))).toEqual({ state: 'candidate' }); // counter-evidence holds recurrence back
        const accepted: LessonEvidence = { kind: 'accepted', pr: 1, comment: 'y', author: 'lead@x' };
        const rejected: LessonEvidence = { kind: 'rejected', pr: 1, comment: 'n', author: 'lead@x' };
        expect(lessonState(lesson(point(1, 'ann'), outcome, rejected))).toEqual({ state: 'rejected' }); // a person's decision wins
        expect(lessonState(lesson(point(1, 'ann'), rejected, accepted))).toEqual({ state: 'verified', promotedBy: 'person' }); // the latest decision
        expect(lessonState({ ...lesson({ pr: 1, comment: 'old', author: 'r' }), state: 'verified' })).toEqual({ state: 'verified', promotedBy: 'legacy' }); // a record from before evidence keeps its state
    });

    it('takes a lesson an outcome alone promoted back to a candidate, once, with why, and leaves every other lesson as it was', () => {
        const point = (pr: number, prAuthor: string, reviewer: string): LessonEvidence => ({ kind: 'point', pr, comment: `c${pr}`, author: reviewer, prAuthor });
        const outcome: LessonEvidence = { kind: 'outcome', pr: 1, comment: 'outcome-abc', author: '', detail: 'fixed later by abc "fix: x"' };
        const stored = (id: string, evidence: LessonEvidence[], promotedBy: ReviewLesson['promotedBy']): ReviewLesson => ({ id, text: id, file: 'src/a.ts', symbols: [], state: 'verified', promotedBy, evidence, createdAt: '', updatedAt: '' });
        writeLessons(repo, [
            stored('only-outcome', [point(1, 'ann', 'r1'), outcome], 'outcome'),
            stored('also-recurs', [point(1, 'ann', 'r1'), point(2, 'bob', 'r2'), outcome], 'outcome'),
            stored('person', [point(1, 'ann', 'r1'), outcome, { kind: 'accepted', pr: 1, comment: 'y', author: 'lead@x' }], 'person'),
        ]);
        const [only, recurs, person] = readLessons(repo);
        expect(only).toMatchObject({ state: 'candidate', evidence: [point(1, 'ann', 'r1'), outcome, { kind: 'reclassified', comment: 'reclassified-only-outcome', detail: 'promoted by the exact-line rule, which no longer promotes on its own' }] });
        expect(only.promotedBy).toBeUndefined();
        expect(recurs).toMatchObject({ state: 'verified', promotedBy: 'recurrence' });
        expect(recurs.evidence.some(e => e.kind === 'reclassified')).toBe(false);
        expect(person).toMatchObject({ state: 'verified', promotedBy: 'person', evidence: [point(1, 'ann', 'r1'), outcome, { kind: 'accepted' }] });
        // Kept by the next write, and never added twice.
        writeLessons(repo, readLessons(repo));
        expect(readLessons(repo)[0].evidence.filter(e => e.kind === 'reclassified')).toHaveLength(1);
        // A person promoting it again is final.
        decideLesson(repo, 'only-outcome', 'accepted', 'lead@x');
        expect(readLessons(repo)[0]).toMatchObject({ state: 'verified', promotedBy: 'person' });
    });

    it('takes a lesson only review bots promoted back to a candidate, with why, and keeps one with a person\'s point verified', () => {
        const point = (pr: number, prAuthor: string, reviewer: string, source: 'person' | 'bot'): LessonEvidence => ({ kind: 'point', pr, comment: `c${pr}`, author: reviewer, source, prAuthor });
        const stored = (id: string, evidence: LessonEvidence[]): ReviewLesson => ({ id, text: id, file: 'src/a.ts', symbols: [], state: 'verified', promotedBy: 'recurrence', evidence, createdAt: '', updatedAt: '' });
        writeLessons(repo, [
            stored('bots', [point(1, 'ann', 'rabbit[bot]', 'bot'), point(2, 'bob', 'helper[bot]', 'bot')]),
            stored('with-person', [point(1, 'ann', 'lead', 'person'), point(2, 'bob', 'helper[bot]', 'bot')]),
        ]);
        const [bots, withPerson] = readLessons(repo);
        expect(bots).toMatchObject({ state: 'candidate', evidence: [{}, {}, { kind: 'reclassified', comment: 'reclassified-bots', detail: 'only review bots raised it (no person)' }] });
        expect(bots.promotedBy).toBeUndefined();
        expect(pendingDecision(bots)?.detail).toBe('only review bots raised it (no person)');
        expect(withPerson).toMatchObject({ state: 'verified', promotedBy: 'recurrence' });
        expect(withPerson.evidence.some(e => e.kind === 'reclassified')).toBe(false);
        writeLessons(repo, readLessons(repo));
        expect(readLessons(repo)[0].evidence.filter(e => e.kind === 'reclassified')).toHaveLength(1);
        decideLesson(repo, 'bots', 'accepted', 'lead@x');
        expect(readLessons(repo)[0]).toMatchObject({ state: 'verified', promotedBy: 'person' });
    });

    it('never serves a candidate only review bots raised, even when a team serves candidates', () => {
        const point = (source: 'person' | 'bot'): LessonEvidence => ({ kind: 'point', pr: 1, comment: `c-${source}`, author: source === 'bot' ? 'rabbit[bot]' : 'lead', source });
        const candidate = (id: string, ...evidence: LessonEvidence[]): ReviewLesson => ({ id, text: id, file: 'src/a.ts', symbols: [], state: 'candidate', evidence, createdAt: '', updatedAt: '' });
        const lessons = [candidate('bot-only', point('bot')), candidate('person', point('person')), candidate('both', point('bot'), point('person')), { ...candidate('standard', point('bot')), file: '', scope: 'repo' as const }];
        const change = { files: ['src/a.ts'], symbols: new Set<string>() };
        expect(matchLessons(lessons, change, { includeCandidates: true }).map(l => l.id).sort()).toEqual(['both', 'person']);
        writeLessons(repo, lessons);
        expect(activeLessons(repo, 'all').map(l => l.id).sort()).toEqual(['both', 'person']);
        // A later fix on its lines is evidence, not a person raising it: still bot-only, still not served.
        const withLines = { ...candidate('lines', point('bot')), evidence: [point('bot'), { kind: 'lines' as const, pr: 9, comment: 'lines-9', author: '', detail: 'fixed later' }] };
        expect(raisedOnlyByBots(withLines)).toBe(true);
        expect(quietBotCandidate(withLines)).toBe(true);
        expect(matchLessons([withLines], change, { includeCandidates: true })).toEqual([]);
        // Once a person accepts it, it is served like any lesson.
        decideLesson(repo, 'bot-only', 'accepted', 'lead@x');
        expect(activeLessons(repo, 'verified').map(l => l.id)).toEqual(['bot-only']);
    });

    it('says which account could not read the repository on a 401, 403 or 404, how to name another, and never the token', async () => {
        for (const status of [401, 403, 404]) {
            const denied = (async () => ({ ok: false, status, json: async () => ({}) })) as never;
            const error = await learnFromReviews(repo, { token: 'secret-token-value', readAs: 'work-account', repo: 'acme/app', fetch: denied }).then(() => '', e => (e as Error).message);
            expect(error).toBe(`can't read acme/app as work-account (HTTP ${status}): the account may not have access; name another with review.github_account / RIGOUR_GITHUB_ACCOUNT, or check gh auth status. Asked for /pulls?state=closed&sort=updated&direction=desc&per_page=100&page=1.`);
            expect(error).not.toContain('secret-token-value');
        }
        // Any other failure keeps the plain status.
        const down = (async () => ({ ok: false, status: 502, json: async () => ({}) })) as never;
        await expect(learnFromReviews(repo, { token: 't', repo: 'acme/app', fetch: down })).rejects.toThrow('GitHub /pulls?state=closed&sort=updated&direction=desc&per_page=100&page=1: HTTP 502');
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
        // A lesson learned only from the pull request under review is its own reviews, already in front of the judge.
        const own = { ...base, id: '7', text: 'from this very pull request', file: 'src/orders.ts', state: 'verified' as const, evidence: [{ pr: 42, comment: 'c', author: 'r' }] };
        const also = { ...own, id: '8', text: 'from this and another', evidence: [{ pr: 42, comment: 'c', author: 'r' }, { pr: 3, comment: 'd', author: 'r' }] };
        expect(matchLessons([...lessons, own, also], change, { excludePr: 42 }).map(l => l.id).sort()).toEqual(['1', '2', '8']); // '7' is left out; '8' has evidence elsewhere too
        // One file's many lessons never crowd out another file's only one.
        const many = Array.from({ length: 6 }, (_, i) => ({ ...base, id: `m${i}`, text: `orders lesson ${i}`, file: 'src/orders.ts', state: 'verified' as const, symbols: ['insertOrder', 'orderId'] }));
        const lone = { ...base, id: 'lone', text: 'the only lesson about the manifest', file: 'src/manifest.sha', state: 'verified' as const };
        const served = matchLessons([...many, lone], { files: ['src/orders.ts', 'src/manifest.sha'], symbols: new Set(['insertOrder', 'orderId']) }, { limit: 4, perFile: 3 });
        expect(served.map(l => l.id)).toEqual(['m0', 'm1', 'm2', 'lone']);
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

describe('learning from merged pull requests, after the merge', () => {
    /**
     * main with src/orders.ts; pull request #7 from `feature`, merged with a merge commit; one inline point on its line 2
     * that the pull request left alone; then `after` on main. GitHub is faked: the merged pull request and that comment.
     */
    async function learnAfter(after: (merge: string) => void): Promise<ReviewLesson> {
        write('export function total(order) {\n  return order.items.length;\n}\n');
        commit('base');
        git('checkout', '-qb', 'feature');
        write('export function total(order) {\n  const n = order.items.length;\n  return n;\n}\n');
        const reviewed = commit('pr head');
        git('checkout', '-q', 'main');
        git('merge', '-q', '--no-ff', '--no-edit', 'feature');
        const merge = git('rev-parse', 'HEAD');
        after(merge);
        const api = 'https://api.github.com/repos/acme/app';
        const pages: Record<string, unknown> = {
            [`${api}/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=1`]: [{ number: 7, merged_at: '2026-09-01T00:00:00Z', merge_commit_sha: merge, user: { login: 'dev' } }],
            [`${api}/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=2`]: [],
            [`${api}/pulls/7/comments?per_page=100`]: [{ id: 1, path: 'src/orders.ts', original_line: 2, original_commit_id: reviewed, body: 'Guard a missing items list here.', user: { login: 'priya' } }],
            [`${api}/pulls/7/reviews?per_page=100`]: [],
        };
        const fetchImpl = async (url: string) => ({ ok: url in pages, status: url in pages ? 200 : 404, json: async () => pages[url] });
        await learnFromReviews(repo, { token: 't', repo: 'acme/app', fetch: fetchImpl, mainRef: 'main' });
        return readLessons(repo)[0];
    }

    it('records a later fix on the point\'s lines as evidence for a person, and the lesson stays a candidate', async () => {
        const lesson = await learnAfter(() => {
            write('// header\nexport function total(order) {\n  const n = order.items?.length ?? 0;\n  return n;\n}\n');
            commit('fix: total crashes on an order with no items');
        });
        expect(lesson.state).toBe('candidate');
        expect(lesson.evidence.map(e => e.kind)).toEqual(['point', 'lines']);
        expect(lesson.evidence[1].detail).toContain('fix: total crashes on an order with no items');
    });

    it('records a revert of the pull request the same way, never a promotion', async () => {
        const lesson = await learnAfter(merge => {
            git('revert', '-m', '1', '--no-edit', merge);
            git('commit', '-q', '--amend', '-m', `Revert "total" (#7)`);
        });
        expect(lesson.state).toBe('candidate');
        expect(lesson.evidence.map(e => e.kind)).toEqual(['point', 'lines']);
        expect(lesson.evidence[1].comment).toMatch(/^revert-/);
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
    it('learns from a merged pull request only what was posted before --until, and marks a comment edited after it', async () => {
        write(V1);
        const reviewed = commit('pr head');
        write(V2);
        const merged = commit('address review');
        const api = 'https://api.github.com/repos/acme/app';
        const until = '2026-09-10T00:00:00Z';
        const pages: Record<string, unknown> = {
            [`${api}/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=1`]: [{ number: 5, merged_at: '2026-09-01T00:00:00Z', merge_commit_sha: merged, user: { login: 'dev' } }],
            [`${api}/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=2`]: [],
            [`${api}/pulls/5/comments?per_page=100`]: [
                { id: 51, path: 'src/orders.ts', original_line: 2, original_commit_id: reviewed, created_at: '2026-08-30T00:00:00Z', updated_at: '2026-08-30T00:00:00Z', body: '**Use an upsert keyed on `id` so retries do not duplicate orders.**', user: { login: 'priya' } },
                { id: 52, path: 'src/orders.ts', original_line: 2, original_commit_id: reviewed, created_at: '2026-08-30T00:00:00Z', updated_at: '2026-09-15T00:00:00Z', body: '**Bound the batch size the insert sends in one call.**', user: { login: 'priya' } },
                { id: 53, path: 'src/orders.ts', original_line: 2, original_commit_id: reviewed, created_at: '2026-09-12T00:00:00Z', updated_at: '2026-09-12T00:00:00Z', body: '**Rename this to orderRows for clarity later.**', user: { login: 'sam' } },
            ],
            [`${api}/pulls/5/reviews?per_page=100`]: [
                { id: 61, commit_id: reviewed, submitted_at: '2026-08-31T00:00:00Z', user: { login: 'priya' }, body: '- Bound both ends of every time window a scheduled job reads.' },
                { id: 62, commit_id: reviewed, submitted_at: '2026-09-20T00:00:00Z', user: { login: 'sam' }, body: '- Add a test for the empty batch.' },
            ],
        };
        const fetchImpl = async (url: string) => ({ ok: url in pages, status: url in pages ? 200 : 404, json: async () => pages[url] });
        await learnFromReviews(repo, { token: 't', repo: 'acme/app', fetch: fetchImpl, until });
        const points = readLessons(repo).flatMap(l => l.evidence.filter(e => e.kind === 'point'));
        // Posted after --until (comment 53, review 62): not in a store as of then.
        expect(points.map(e => e.comment).sort()).toEqual(['51', '52', 'review-61-0']);
        // Edited after --until: kept, marked, since only its edited text is served.
        expect(points.find(e => e.comment === '52')?.editedAfterUntil).toBe(true);
        expect(points.find(e => e.comment === '51')?.editedAfterUntil).toBeUndefined();
    });

    it('compares --until as an instant: an offset reads right against UTC, and an unreadable one is refused', async () => {
        write(V1);
        const reviewed = commit('pr head');
        write(V2);
        const merged = commit('address review');
        const api = 'https://api.github.com/repos/acme/app';
        // 10:00 at +05:30 is 04:30 UTC: a comment at 04:29Z is before it, one at 04:31Z after it.
        const until = '2026-09-25T10:00:00+05:30';
        const pages: Record<string, unknown> = {
            [`${api}/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=1`]: [{ number: 6, merged_at: '2026-09-20T00:00:00Z', merge_commit_sha: merged, user: { login: 'dev' } }],
            [`${api}/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=2`]: [],
            [`${api}/pulls/6/comments?per_page=100`]: [
                { id: 71, path: 'src/orders.ts', original_line: 2, original_commit_id: reviewed, created_at: '2026-09-25T04:29:00Z', updated_at: '2026-09-25T04:29:00Z', body: '**Use an upsert keyed on `id` so retries do not duplicate orders.**', user: { login: 'priya' } },
                { id: 72, path: 'src/orders.ts', original_line: 2, original_commit_id: reviewed, created_at: '2026-09-25T04:31:00Z', updated_at: '2026-09-25T04:31:00Z', body: '**Bound the batch size the insert sends in one call.**', user: { login: 'priya' } },
            ],
            [`${api}/pulls/6/reviews?per_page=100`]: [],
        };
        const fetchImpl = async (url: string) => ({ ok: url in pages, status: url in pages ? 200 : 404, json: async () => pages[url] });
        await learnFromReviews(repo, { token: 't', repo: 'acme/app', fetch: fetchImpl, until });
        expect(readLessons(repo).flatMap(l => l.evidence.filter(e => e.kind === 'point').map(e => e.comment))).toEqual(['71']);
        await expect(learnFromReviews(repo, { token: 't', repo: 'acme/app', fetch: fetchImpl, until: 'last tuesday' })).rejects.toThrow('--until "last tuesday" is not a date or a time');
    });

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

    it('skips points that ask for nothing, counts them by why, and keeps the request beside them', async () => {
        write(V1);
        const reviewed = commit('pr head');
        write(V2);
        const merged = commit('address review');
        const api = 'https://api.github.com/repos/acme/app';
        const pages: Record<string, unknown> = {
            [`${api}/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=1`]: [{ number: 9, merged_at: '2026-09-02T00:00:00Z', merge_commit_sha: merged, user: { login: 'dev' } }],
            [`${api}/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=2`]: [],
            [`${api}/pulls/9/comments?per_page=100`]: [
                { id: 31, path: 'src/orders.ts', original_line: 2, original_commit_id: reviewed, body: 'LGTM, thanks for the quick turnaround!', user: { login: 'priya' } },
            ],
            [`${api}/pulls/9/reviews?per_page=100`]: [
                { id: 41, commit_id: reviewed, user: { login: 'review-helper[bot]', type: 'Bot' }, body: '### Changes recommended\n\n**Changes:**\n- Adds caching for the order list.\n- Updates the order schema and its tests.\n- Bound the retry loop in src/orders.ts: it never stops on a permanent error.\n- **Files reviewed:** 3/3 changed files' },
            ],
        };
        const fetchImpl = async (url: string) => ({ ok: url in pages, status: url in pages ? 200 : 404, json: async () => pages[url] });
        const result = await learnFromReviews(repo, { token: 't', repo: 'acme/app', fetch: fetchImpl });
        expect(result.skipped).toEqual({ 'describes the change': 2, 'review tool status': 1, 'praise or thanks': 1 });
        expect(result.candidates).toEqual({ person: 0, bot: 1 });
        expect(readLessons(repo).map(l => l.text)).toEqual(['Bound the retry loop in src/orders.ts: it never stops on a permanent error.']);
    });
});
