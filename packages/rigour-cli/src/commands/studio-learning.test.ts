import { describe, expect, it } from 'vitest';
import type { AgentEvent, LessonRecord, Story } from '@rigour-labs/core';
import { buildLearning, readableFixLesson } from './studio-learning.js';

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
