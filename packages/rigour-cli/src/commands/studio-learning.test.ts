import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { readLessons, type AgentEvent, type LessonRecord, type ReviewLesson, type Story } from '@rigour-labs/core';
import { buildLearning, decideReviewLesson, readableFixLesson } from './studio-learning.js';

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
            expect(() => decideReviewLesson(repo, { id: 'a1b2c3d4e5f6', decision: 'validated' })).toThrow('accepted or rejected');
            expect(() => decideReviewLesson(repo, { id: 'ffffffffffff', decision: 'accepted' })).toThrow('no review lesson');
        } finally {
            fs.rmSync(repo, { recursive: true, force: true });
        }
    });
});
