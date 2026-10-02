import { describe, expect, it } from 'vitest';
import { buildAgentContext } from './studio-context.js';

const now = new Date('2026-10-09T12:00:00Z');
const t = (iso: string) => Date.parse(iso);

describe('buildAgentContext', () => {
    it('sums what agents were given this week: focused files, recalls, lessons, reuse', () => {
        const ctx = buildAgentContext({
            now,
            context: [
                { toolName: 'rigour_context_scope', cacheStatus: 'none', candidateFiles: 180, returnedFiles: 6, candidateTokens: 90000, returnedTokens: 4000, createdAt: t('2026-10-08T00:00:00Z') },
                { toolName: 'rigour_context_scope', cacheStatus: 'none', candidateFiles: 180, returnedFiles: 4, candidateTokens: 90000, returnedTokens: 3000, createdAt: t('2026-09-01T00:00:00Z') },
                { toolName: 'rigour_recall', cacheStatus: 'none', candidateTokens: 0, returnedTokens: 200, createdAt: t('2026-10-07T00:00:00Z') },
            ],
            events: [
                { type: 'lessons_served', timestamp: '2026-10-07T00:00:00Z', lessons: ['a', 'b'] },
                { type: 'reuse_suggested', timestamp: '2026-10-08T00:00:00Z', planned: 'formatMoney', existing: 'formatCents in src/lib/money.ts:12', action: 'BLOCK' },
            ],
        });
        expect(ctx.week).toEqual({
            scopes: 1, filesConsidered: 180, filesReturned: 6, tokensConsidered: 90000, tokensReturned: 4000, recalls: 1, lessonsTold: 2,
            reuse: [{ at: '2026-10-08T00:00:00Z', planned: 'formatMoney', existing: 'formatCents in src/lib/money.ts:12', action: 'BLOCK' }],
        });
        expect(ctx.weeks.at(-1)).toMatchObject({ scopes: 1, filesReturned: 6, filesConsidered: 180, recalls: 1, lessonsTold: 2, reuse: 1 });
        expect(ctx.weeks.reduce((n, w) => n + w.scopes, 0)).toBe(2); // September 1 is inside the 8 weeks
    });
});
