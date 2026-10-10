import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { readCompiledChecks, readLessons, type AgentEvent, type LessonRecord, type ReviewLesson, type Story } from '@rigour-labs/core';
import { buildLearning, decideCompiledCheckFromStudio, decideReviewLesson, proposeChecksFromStudio, readableFixLesson } from './studio-learning.js';

const now = new Date('2026-10-09T12:00:00Z');
const lesson: LessonRecord = {
    id: 'l1', repositoryId: 'r', visibility: 'team' as any, state: 'validated' as any, kind: 'fix',
    subject: 'Fixed before: Credential header follows redirects (semantic-bugs). The cookie reaches fetch.',
    evidence: { files: ['src/a.ts', 'src/b.ts'] }, confidence: 1, source: 'fix', createdAt: Date.parse('2026-09-20T00:00:00Z'), updatedAt: 0,
};
const story = (at: string, stage: Story['stage'] = 'edit'): Story => ({ id: at, at, stage, file: 'src/c.ts', rule: 'semantic-bugs', title: 'Credential header follows redirects', diff: [] });

describe('buildLearning', () => {
    it("follows a lesson from where it was learned to the repeats it stopped", () => {
        const events: AgentEvent[] = [
            { type: 'lessons_served', timestamp: '2026-10-01T00:00:00Z', via: 'recall', lessons: [lesson.subject] },
            { type: 'lessons_served', timestamp: '2026-10-02T00:00:00Z', via: 'review', lessons: [lesson.subject, 'other'] },
        ];
        const learning = buildLearning({ now, lessons: [lesson], reviewLessons: [], stories: [story('2026-09-19T00:00:00Z', 'stop'), story('2026-10-05T00:00:00Z')], events });
        expect(learning.lessons[0]).toMatchObject({
            text: 'Credential header follows redirects: The cookie reaches fetch.',
            origin: 'development', learnedFrom: '2 fixes as an agent tried to finish', scope: 'team',
            told: 2, stoppedInDevelopment: 1, reachedPr: null,
        });
        expect(learning.prRecorded).toBe(false);
        expect(learning.weeks.map(w => [w.stoppedInDevelopment, w.reachedPr])).toEqual([[0, null], [0, null], [0, null], [1, null]]);
    });

    it('counts repeats that reached a PR once branch reviews are recorded here', () => {
        const events: AgentEvent[] = [{ type: 'pr_catches', timestamp: '2026-10-08T00:00:00Z', findings: [{ rule: 'semantic-bugs', title: 'Credential header follows redirects', file: 'src/d.ts' }] }];
        const learning = buildLearning({ now, lessons: [lesson], reviewLessons: [], stories: [], events });
        expect(learning.lessons[0].reachedPr).toBe(1);
        expect(learning.weeks[3].reachedPr).toBe(1);
    });

    it('does not repeat the title when the detail says the same thing', () => {
        const same = { ...lesson, subject: 'Fixed before: Stripe API key detected in code (security-patterns). Stripe API key detected in code.' };
        expect(buildLearning({ now, lessons: [same], reviewLessons: [], stories: [], events: [] }).lessons[0].text).toBe('Stripe API key detected in code');
    });

    it('shows a lesson once, in words, without a truncated title or rule tag', () => {
        expect(readableFixLesson("Fixed before: [credential-redirect] The `x-hook-signature` header is sent through `fetch(endpoint, { method: 'POST', headers: { 'x-h…` (semantic-bugs). [credential-redirect] The `x-hook-signature` header is sent through `fetch(endpoint, { method: 'POST', headers: { 'x-hook-signature': signature } })` without `redirect: \"manual\"`."))
            .toBe("The `x-hook-signature` header is sent through `fetch(endpoint, { method: 'POST', headers: { 'x-hook-signature': signature } })` without `redirect: \"manual\"`");
        const twice = [lesson, { ...lesson, id: 'l2', visibility: 'personal' as any }];
        expect(buildLearning({ now, lessons: twice, reviewLessons: [], stories: [], events: [] }).lessons).toHaveLength(1);
    });
});

describe('a review lesson evidence took back', () => {
    const takenBack = (extra: ReviewLesson['evidence'] = []): ReviewLesson => ({
        id: 'a1b2c3d4e5f6', text: 'take the lock before the first read', file: 'src/job.ts', symbols: [], state: extra.some(e => e.kind === 'accepted') ? 'verified' : 'candidate', createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z',
        evidence: [
            { kind: 'point', pr: 1, comment: 'c1', author: 'r1' },
            { kind: 'against', pr: 50, comment: 'against-50', author: '', at: '2026-09-10T00:00:00Z' },
            { kind: 'against', pr: 51, comment: 'against-51', author: '', at: '2026-09-20T00:00:00Z' },
            { kind: 'demoted', pr: 51, comment: 'demoted-50-51', author: '', detail: 'taken back: #50, #51 repeated it and settled clean', at: '2026-10-01T00:00:00Z' },
            ...extra,
        ],
    });

    it('shows why and which pull requests, and lets a person promote it again', () => {
        const [journey] = buildLearning({ now, lessons: [], reviewLessons: [takenBack()], stories: [], events: [] }).lessons;
        expect(journey.learnedFrom).toBe('At PR #1, from r1'); // the review point, not the pull requests that took it back
        expect(journey).toMatchObject({ canDecide: true, takenBack: { detail: 'taken back: #50, #51 repeated it and settled clean', prs: [50, 51], at: '2026-10-01T00:00:00Z' } });
    });

    it('no longer shows it as taken back once a person promoted it again', () => {
        const [journey] = buildLearning({ now, lessons: [], reviewLessons: [takenBack([{ kind: 'accepted', pr: 1, comment: 'accepted-x', author: 'lead@team' }])], stories: [], events: [] }).lessons;
        expect(journey.takenBack).toBeUndefined();
        expect(journey.canDecide).toBe(false);
    });

    it('records a decision from Studio with the person\'s git email, final, and refuses what is not a lesson or a decision', () => {
        const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-decide-'));
        try {
            execFileSync('git', ['-C', repo, 'init', '-q']);
            execFileSync('git', ['-C', repo, 'config', 'user.email', 'lead@team.example']);
            fs.mkdirSync(path.join(repo, '.rigour'));
            fs.writeFileSync(path.join(repo, '.rigour', 'review-lessons.json'), JSON.stringify({ version: 1, lessons: [takenBack()] }));
            expect(decideReviewLesson(repo, { id: 'a1b2c3d4e5f6', decision: 'accepted' })).toEqual({ id: 'a1b2c3d4e5f6', state: 'verified' });
            const decision = readLessons(repo)[0].evidence.at(-1);
            expect(decision).toMatchObject({ kind: 'accepted', author: 'lead@team.example', detail: 'decided in Studio' });
            expect(() => decideReviewLesson(repo, { id: 'nope', decision: 'accepted' })).toThrow('12 hex characters');
            expect(() => decideReviewLesson(repo, { id: 'a1b2c3d4e5f6', decision: 'validated' })).toThrow('accepted, rejected, dismissed, reworded or scope');
            expect(() => decideReviewLesson(repo, { id: 'a1b2c3d4e5f6', decision: 'reworded' })).toThrow('with a suggested wording');
            expect(() => decideReviewLesson(repo, { id: 'ffffffffffff', decision: 'accepted' })).toThrow('no review lesson');
        } finally {
            fs.rmSync(repo, { recursive: true, force: true });
        }
    });
});

describe('a candidate a later fix changed the lines of', () => {
    const suggested = (extra: ReviewLesson['evidence'] = []): ReviewLesson => ({
        id: 'b1b2c3d4e5f6', text: 'keep the composer scrollable', file: 'src/chat.ts', symbols: [], state: extra.some(e => e.kind === 'accepted') ? 'verified' : 'candidate', createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z',
        evidence: [
            { kind: 'point', pr: 4, comment: 'c4', author: 'r1', actedOn: false },
            { kind: 'lines', pr: 4, comment: 'lines-4-abc', author: '', detail: 'fixed later by abc123def "fix: composer overflow"', at: '2026-09-05T00:00:00Z' },
            ...extra,
        ],
    });

    it('shows the fix for a person to promote or dismiss, and nothing once they have', () => {
        const view = (l: ReviewLesson) => buildLearning({ now, lessons: [], reviewLessons: [l], stories: [], events: [] }).lessons[0];
        expect(view(suggested())).toMatchObject({ canDecide: true, suggested: { detail: 'fixed later by abc123def "fix: composer overflow"', pr: 4 } });
        const dismissed = view(suggested([{ kind: 'dismissed', pr: 4, comment: 'dismissed-x', author: 'lead@team' }]));
        expect(dismissed.suggested).toBeUndefined();
        expect(dismissed.state).toBe('candidate');
        expect(view(suggested([{ kind: 'accepted', pr: 4, comment: 'accepted-x', author: 'lead@team' }])).suggested).toBeUndefined();
    });

    it('records a dismissal from Studio and leaves the lesson a candidate', () => {
        const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-dismiss-'));
        try {
            execFileSync('git', ['-C', repo, 'init', '-q']);
            execFileSync('git', ['-C', repo, 'config', 'user.email', 'lead@team.example']);
            fs.mkdirSync(path.join(repo, '.rigour'));
            fs.writeFileSync(path.join(repo, '.rigour', 'review-lessons.json'), JSON.stringify({ version: 1, lessons: [suggested()] }));
            expect(decideReviewLesson(repo, { id: 'b1b2c3d4e5f6', decision: 'dismissed' })).toEqual({ id: 'b1b2c3d4e5f6', state: 'candidate' });
            expect(readLessons(repo)[0].evidence.at(-1)).toMatchObject({ kind: 'dismissed', author: 'lead@team.example' });
        } finally {
            fs.rmSync(repo, { recursive: true, force: true });
        }
    });
});

describe('a lesson back to a candidate when outcomes stopped promoting', () => {
    it('comes first, with why and the evidence that had promoted it, for a person to promote again or dismiss', () => {
        const newer: ReviewLesson = { id: 'c1c2c3d4e5f6', text: 'newer lesson', file: 'src/x.ts', symbols: [], state: 'candidate', createdAt: '2026-10-05T00:00:00Z', updatedAt: '', evidence: [{ kind: 'point', pr: 9, comment: 'c9', author: 'r' }] };
        const back: ReviewLesson = { id: 'd1d2c3d4e5f6', text: 'guard a missing items list', file: 'src/orders.ts', symbols: [], state: 'candidate', createdAt: '2026-09-01T00:00:00Z', updatedAt: '', evidence: [
            { kind: 'point', pr: 7, comment: 'c7', author: 'r' },
            { kind: 'outcome', pr: 7, comment: 'outcome-abc', author: '', detail: 'fixed later by abc123def "fix: total crashes"' },
            { kind: 'reclassified', pr: 7, comment: 'reclassified-d1d2c3d4e5f6', author: '', detail: 'promoted by the exact-line rule, which no longer promotes on its own' },
        ] };
        const lessons = buildLearning({ now, lessons: [], reviewLessons: [newer, back], stories: [], events: [] }).lessons;
        expect(lessons.map(l => l.id)).toEqual(['d1d2c3d4e5f6', 'c1c2c3d4e5f6']);
        expect(lessons[0]).toMatchObject({ canDecide: true, reclassified: { detail: 'promoted by the exact-line rule, which no longer promotes on its own', evidence: ['fixed later by abc123def "fix: total crashes"'] } });
        const decided = buildLearning({ now, lessons: [], reviewLessons: [{ ...back, evidence: [...back.evidence, { kind: 'dismissed', pr: 7, comment: 'dismissed-x', author: 'lead@team' }] }], stories: [], events: [] }).lessons[0];
        expect(decided.reclassified).toBeUndefined();
    });

    it('says when only review bots had promoted it, after an upgrade reads a store they verified', () => {
        const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-bots-'));
        try {
            const bot = (pr: number, author: string) => ({ kind: 'point' as const, pr, comment: `c${pr}`, author, source: 'bot' as const, prAuthor: `author-${pr}` });
            fs.mkdirSync(path.join(repo, '.rigour'));
            fs.writeFileSync(path.join(repo, '.rigour', 'review-lessons.json'), JSON.stringify({ version: 1, lessons: [{ id: 'b1b2c3d4e5f6', text: 'Add more tests.', file: 'src/x.ts', symbols: [], state: 'verified', promotedBy: 'recurrence', createdAt: '', updatedAt: '', evidence: [bot(1, 'rabbit[bot]'), bot(2, 'helper[bot]')] }] }));
            const [lesson] = buildLearning({ now, lessons: [], reviewLessons: readLessons(repo), stories: [], events: [] }).lessons;
            expect(lesson).toMatchObject({ state: 'candidate', canDecide: true, reclassified: { detail: 'only review bots raised it (no person)' } });
            // Its reason waits on a person, so it is not hidden with the other bot points.
            expect(lesson.fromBots).toBeUndefined();
            const quiet = buildLearning({ now, lessons: [], reviewLessons: [{ id: 'q1', text: 'Add docs.', file: 'src/x.ts', symbols: [], state: 'candidate', createdAt: '', updatedAt: '', evidence: [bot(3, 'rabbit[bot]')] }], stories: [], events: [] }).lessons[0];
            expect(quiet.fromBots).toBe(true);
            // A later fix on its lines is evidence for a person to look at, not a person raising it: still from bots.
            const withLines = buildLearning({ now, lessons: [], reviewLessons: [{ id: 'q2', text: 'Add types.', file: 'src/x.ts', symbols: [], state: 'candidate', createdAt: '', updatedAt: '', evidence: [bot(4, 'rabbit[bot]'), { kind: 'lines', pr: 9, comment: 'lines-9-abc', author: '', detail: 'fixed later by abc' }] }], stories: [], events: [] }).lessons[0];
            expect(withLines.fromBots).toBe(true);
        } finally {
            fs.rmSync(repo, { recursive: true, force: true });
        }
    });

    it('proposes compiled checks from Studio, and records a decision with the person\'s git email or refuses without one', () => {
        const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-compiled-'));
        try {
            execFileSync('git', ['-C', repo, 'init', '-q']);
            execFileSync('git', ['-C', repo, 'config', 'user.email', 'lead@team.example']);
            fs.mkdirSync(path.join(repo, '.rigour'));
            fs.writeFileSync(path.join(repo, '.rigour', 'review-lessons.json'), JSON.stringify({ version: 1, lessons: [{ id: 'L1', text: 'Never call `fetchAll` here.', file: 'src/load.ts', symbols: ['fetchAll'], state: 'verified', createdAt: '', updatedAt: '', evidence: [{ kind: 'point', pr: 1, comment: 'p', author: 'r' }, { kind: 'accepted', pr: 1, comment: 'a', author: 'lead@team.example' }] }] }));
            expect(proposeChecksFromStudio(repo)).toEqual({ proposed: 1 });
            expect(decideCompiledCheckFromStudio(repo, { id: 'c-L1', state: 'active' })).toMatchObject({ state: 'active', by: 'lead@team.example' });
            expect(() => decideCompiledCheckFromStudio(repo, { id: 'c-L1', state: 'proposed' })).toThrow('active or withdrawn');
            expect(() => decideCompiledCheckFromStudio(repo, { id: 'c-nope', state: 'withdrawn' })).toThrow('no compiled check');
            execFileSync('git', ['-C', repo, 'config', 'user.email', '']);
            expect(() => decideCompiledCheckFromStudio(repo, { id: 'c-L1', state: 'withdrawn' })).toThrow('no git email');
            expect(readCompiledChecks(repo)[0].state).toBe('active');
        } finally {
            fs.rmSync(repo, { recursive: true, force: true });
        }
    });
});


describe('a corrected wording for a lesson a person decided', () => {
    it('is shown beside the lesson, and taken from Studio only on the person\'s word, recorded', () => {
        const decided: ReviewLesson = {
            id: 'c1b2c3d4e5f6', text: 'This reads every row.', file: 'src/a.ts', symbols: [], state: 'verified', promotedBy: 'person', createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z',
            suggestedText: 'This reads every row. Filter in the query.', suggestedWhy: 'parser fix',
            evidence: [{ kind: 'point', pr: 3, comment: 'c3', author: 'r1' }, { kind: 'accepted', pr: 3, comment: 'accepted-1', author: 'lead@team' }],
        };
        const [journey] = buildLearning({ now, lessons: [], reviewLessons: [decided], stories: [], events: [] }).lessons;
        expect([journey.text, journey.suggestedText]).toEqual(['This reads every row.', { text: 'This reads every row. Filter in the query.', why: 'parser fix' }]);
        const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-reworded-'));
        try {
            execFileSync('git', ['-C', repo, 'init', '-q']);
            execFileSync('git', ['-C', repo, 'config', 'user.email', 'lead@team.example']);
            fs.mkdirSync(path.join(repo, '.rigour'));
            fs.writeFileSync(path.join(repo, '.rigour', 'review-lessons.json'), JSON.stringify({ version: 1, lessons: [decided] }));
            expect(decideReviewLesson(repo, { id: 'c1b2c3d4e5f6', decision: 'reworded' })).toEqual({ id: 'c1b2c3d4e5f6', state: 'verified' });
            expect(readLessons(repo)[0]).toMatchObject({ text: 'This reads every row. Filter in the query.' });
            expect(readLessons(repo)[0].evidence.at(-1)).toMatchObject({ kind: 'reworded', author: 'lead@team.example', detail: 'parser fix; was: This reads every row.' });
        } finally {
            fs.rmSync(repo, { recursive: true, force: true });
        }
    });
});

describe('how far a review lesson reaches, from Studio', () => {
    const fileLesson: ReviewLesson = {
        id: 'd1b2c3d4e5f6', text: 'Filter in the query.', file: 'src/orders.ts', symbols: [], state: 'verified', createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z',
        evidence: [{ kind: 'point', pr: 1, comment: 'c1', author: 'r1' }],
    };
    it('shows the reach on the lesson, and a team standard has no folder to choose', () => {
        const [file] = buildLearning({ now, lessons: [], reviewLessons: [fileLesson], stories: [], events: [] }).lessons;
        expect(file.reach).toEqual({ scope: 'file', hasFile: true });
        const [standard] = buildLearning({ now, lessons: [], reviewLessons: [{ ...fileLesson, file: '', scope: 'repo' }], stories: [], events: [] }).lessons;
        expect(standard.reach).toEqual({ scope: 'repo', hasFile: false });
    });

    it('records a scope with the person\'s git email, and refuses one without an email or with an unknown reach', () => {
        const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-scope-'));
        try {
            execFileSync('git', ['-C', repo, 'init', '-q']);
            execFileSync('git', ['-C', repo, 'config', 'user.email', 'lead@team.example']);
            fs.mkdirSync(path.join(repo, '.rigour'));
            fs.writeFileSync(path.join(repo, '.rigour', 'review-lessons.json'), JSON.stringify({ version: 1, lessons: [fileLesson] }));
            expect(decideReviewLesson(repo, { id: 'd1b2c3d4e5f6', decision: 'scope', to: 'repo' })).toEqual({ id: 'd1b2c3d4e5f6', state: 'verified' });
            expect(readLessons(repo)[0]).toMatchObject({ scope: 'repo' });
            expect(readLessons(repo)[0].evidence.at(-1)).toMatchObject({ kind: 'scoped', author: 'lead@team.example', detail: 'repo: decided in Studio' });
            expect(() => decideReviewLesson(repo, { id: 'd1b2c3d4e5f6', decision: 'scope', to: 'everywhere' })).toThrow('to is file, folder or repo');
            execFileSync('git', ['-C', repo, 'config', 'user.email', '']);
            expect(() => decideReviewLesson(repo, { id: 'd1b2c3d4e5f6', decision: 'scope', to: 'file' })).toThrow('no git email is set');
            expect(readLessons(repo)[0].scope).toBe('repo'); // refused: nothing changed
        } finally {
            fs.rmSync(repo, { recursive: true, force: true });
        }
    });
});
