import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { formatUsd, PrePrReviewView, routerSaving, type PrePrReviewData } from './PrePrReview';

const data: PrePrReviewData = {
    reviewed: { total: 5, fixed: 2, noIssue: 3, byReviewer: { agent: 4, human: 1 } },
    recent: [{ file: 'src/sync.ts', function: 'syncOrders', verdict: 'fixed', reviewer: 'agent', note: 'retry no longer duplicates the order', at: '2026-10-01T10:00:00Z' }],
    pending: [{ file: 'src/pay.ts', function: 'refund', start: 12, questions: ['Is the write safe under concurrent calls?'] }],
    spend: { runs: 4, costUsd: 0.4213, unpricedRuns: 1, inputTokens: 1, outputTokens: 1, functionsRanked: 40, functionsRouted: 10, alreadyReviewed: 3, toolCalls: 30 },
    lastModel: 'anthropic/claude-sonnet-5.5',
};

describe('PrePrReview', () => {
    it('shows what was reviewed and fixed before the PR, what waits, and observed spend', () => {
        const html = renderToStaticMarkup(<PrePrReviewView data={data} />);
        expect(html).toContain('Defects fixed before the PR');
        expect(html).toContain('agent 4 · human 1');
        expect(html).toContain('src/pay.ts:12 · refund');
        expect(html).toContain('retry no longer duplicates the order');
        expect(html).toContain('observed over 4 run(s) · 1 unpriced · router skipped 75% of changed functions · 3 already reviewed');
        expect(html).toContain('anthropic/claude-sonnet-5.5');
    });

    it('formats spend and router savings without inventing numbers', () => {
        expect(formatUsd(0.4213)).toBe('$0.421');
        expect(formatUsd(12.5)).toBe('$12.50');
        expect(routerSaving({ ...data.spend, functionsRanked: 0 })).toBeNull();
    });
});
