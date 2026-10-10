import { describe, expect, it } from 'vitest';
import { overBudget } from './caps.js';

describe('the spending caps', () => {
    const caps = { max_runs_per_day: 40, max_usd_per_day: 10, max_usd_per_review: 2 };

    it('leaves room while every cap does, and names the one that is reached, with its key', () => {
        expect(overBudget({ runs: 3, usd: 1 }, caps, 1, 0.5)).toBeUndefined();
        expect(overBudget({ runs: 3, usd: 1 }, caps, 1, 2)).toBe("this review's cost cap is reached: $2.00 of $2.00 spent by this review (review.reviewer.max_usd_per_review)");
        expect(overBudget({ runs: 40, usd: 1 }, caps, 1)).toContain('(review.reviewer.max_runs_per_day)');
        expect(overBudget({ runs: 3, usd: 10 }, caps, 1)).toContain('(review.reviewer.max_usd_per_day)');
    });

    it('checks the review first: one review may not spend the day', () => {
        expect(overBudget({ runs: 40, usd: 10 }, caps, 1, 2)).toContain('max_usd_per_review');
    });
});
