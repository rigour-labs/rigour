import { describe, expect, it, vi } from 'vitest';
import type { ReviewLesson } from '@rigour-labs/core';
import { briefedSince, contradictions, evidenceTrail } from './studio-learning-health.js';

vi.mock('@rigour-labs/core', async importOriginal => ({
    ...(await importOriginal<typeof import('@rigour-labs/core')>()),
    getApplicableLessons: async () => ({
        lessons: [
            { id: 'mine', visibility: 'personal', repositoryName: 'api' },
            { id: 'theirs', visibility: 'team', repositoryName: 'web' },
        ],
        conflicts: [{ subject: 'Use the pool', lessonIds: ['mine', 'theirs'] }],
    }),
}));
import { buildLearning } from './studio-learning.js';

const now = new Date('2026-10-16T12:00:00Z');

describe('a review lesson\'s evidence, for the Memory page', () => {
    it('lists who made each point at which pull request, and who decided and why, with a teammate by display name', () => {
        const lesson: ReviewLesson = {
            id: 'a1b2c3d4e5f6', text: 'Filter in the query.', file: 'src/orders.ts', symbols: [], state: 'verified', createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z',
            evidence: [
                { kind: 'point', pr: 12, comment: 'c1', author: 'reviewer-a', source: 'person', postedAt: '2026-09-01T00:00:00Z' },
                { pr: 14, comment: 'c2', author: 'review-bot', source: 'bot' },
                { kind: 'accepted', pr: 12, comment: 'accepted-1', author: 'lead@example.com', detail: 'how we work', at: '2026-10-01T00:00:00Z' },
                { kind: 'rejected', pr: 12, comment: 'team-1', author: '', team: { name: 'Sam P.', receivedAt: '2026-10-02T00:00:00Z' } },
            ],
        };
        expect(evidenceTrail(lesson)).toEqual([
            { kind: 'point', pr: 12, author: 'reviewer-a', source: 'person', at: '2026-09-01T00:00:00Z' },
            { kind: 'point', pr: 14, author: 'review-bot', source: 'bot' },
            { kind: 'accepted', pr: 12, author: 'lead@example.com', detail: 'how we work', at: '2026-10-01T00:00:00Z' },
            { kind: 'rejected', pr: 12, author: 'Sam P.', at: '2026-10-02T00:00:00Z', team: true },
        ]);
        const journey = buildLearning({ now, lessons: [], reviewLessons: [lesson], stories: [], events: [] }).lessons[0];
        expect(journey.evidence).toHaveLength(4);
    });
});

describe('lessons briefed to agents, for the Memory page', () => {
    it('counts lessons served in the window, leaving out a briefing\'s rules and requests that carried no lesson', () => {
        expect(briefedSince([
            { type: 'lessons_served', timestamp: '2026-10-10T00:00:00Z', via: 'brief', lessons: ['rule', 'lesson a', 'lesson b'], rules: 1 },
            { type: 'lessons_served', timestamp: '2026-10-11T00:00:00Z', via: 'brief', lessons: ['rule only'], rules: 1 },
            { type: 'lessons_served', timestamp: '2026-10-12T00:00:00Z', via: 'recall', lessons: ['lesson c'] },
            { type: 'lessons_served', timestamp: '2026-08-01T00:00:00Z', via: 'recall', lessons: ['too old'] },
        ], now, 28)).toEqual({ lessons: 3, requests: 2, days: 28 });
    });
});

describe('lessons that contradict each other, for the Memory page', () => {
    it('names, for each lesson, the others with the same words and different evidence', async () => {
        const found = await contradictions('/nowhere');
        expect(found.get('mine')).toEqual(['a team lesson in web']);
        expect(found.get('theirs')).toEqual(['a personal lesson in api']);
    });
});
