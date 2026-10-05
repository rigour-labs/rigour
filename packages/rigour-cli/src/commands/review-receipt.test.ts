import { describe, expect, it } from 'vitest';
import type { QualityReceipt } from '@rigour-labs/core';
import { receiptFor, receiptSummary } from './review-receipt.js';

const receipt = (over: Partial<QualityReceipt>): QualityReceipt => ({
    functions: 4, reviewed: 1, changedSinceReview: 0, lowRisk: 2, notCovered: [], reviewers: {}, otherFiles: 0, setAside: 0, ...over,
});

describe('quality receipt line', () => {
    it('counts what is known, and mentions changes after review only when there are some', () => {
        expect(receiptSummary(receipt({}))).toBe('4 changed functions · 1 reviewed before this · 2 low risk · 0 not covered');
        const gap = { file: 'a.ts', function: 'f', start: 3, score: 4, changedSinceReview: true };
        expect(receiptSummary(receipt({ functions: 1, reviewed: 0, lowRisk: 0, changedSinceReview: 1, notCovered: [gap] })))
            .toBe('1 changed function · 0 reviewed before this · 1 changed after review · 0 low risk · 1 not covered');
    });

    it('has no receipt without a diff', () => {
        expect(receiptFor(process.cwd(), undefined, { gates: {} } as never, false)).toBeNull();
    });
});
