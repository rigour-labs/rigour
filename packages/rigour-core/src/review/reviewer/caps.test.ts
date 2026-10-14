import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { capOrigin, overBudget } from './caps.js';

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

let repo: string;
beforeEach(() => { repo = fs.mkdtempSync(path.join(os.tmpdir(), 'caps-')); });
afterEach(() => { fs.rmSync(repo, { recursive: true, force: true }); });
const today = { runs: 3, usd: 10.4 };
const yml = (text: string) => fs.writeFileSync(path.join(repo, 'rigour.yml'), text);

describe('a review skipped by the daily cost cap', () => {
    it("says the cap is Rigour's default when rigour.yml is silent, and how to change it", () => {
        yml('version: 1\nreview:\n  reviewer:\n    enabled: true\n');
        const reason = overBudget(today, capOrigin({ max_usd_per_day: 10, usd_per_day_from: 'team' }, repo), 1);
        expect(reason).toBe("the daily cost cap is reached: $10.40 of $10.00 reported today in this repository (review.reviewer.max_usd_per_day). The cap is $10.00, Rigour's default: rigour.yml does not set review.reviewer.max_usd_per_day. To change it, set review.reviewer.max_usd_per_day in rigour.yml; your own reviewer.max_usd_per_day (~/.rigour/settings.json) can only lower it.");
    });

    it('treats a repository with no rigour.yml as silent', () => {
        expect(overBudget(today, capOrigin({ max_usd_per_day: 10, usd_per_day_from: 'team' }, repo), 1)).toContain("Rigour's default");
    });

    it('says rigour.yml sets it when it does, even at the default value', () => {
        yml('review:\n  reviewer:\n    max_usd_per_day: 10\n');
        expect(overBudget(today, capOrigin({ max_usd_per_day: 10, usd_per_day_from: 'team' }, repo), 1)).toContain('The cap is $10.00, set by review.reviewer.max_usd_per_day in rigour.yml. To change it, set review.reviewer.max_usd_per_day in rigour.yml');
    });

    it("says a person's own lower cap is theirs, and that rigour.yml's is the most it can be", () => {
        yml('review:\n  reviewer:\n    max_usd_per_day: 25\n');
        const reason = overBudget({ runs: 1, usd: 5 }, capOrigin({ max_usd_per_day: 5, usd_per_day_from: 'user' }, repo), 1);
        expect(reason).toContain('The cap is $5.00, your own reviewer.max_usd_per_day (~/.rigour/settings.json), lower than rigour.yml\'s.');
        expect(reason).toContain('review.reviewer.max_usd_per_day in rigour.yml is the most it can be');
    });

    it('claims no source it cannot tell: a silent rigour.yml with a cap other than the default, or one that does not parse', () => {
        const generic = 'The cap is $1.00: review.reviewer.max_usd_per_day in rigour.yml, $10 by default when it does not set it.';
        expect(overBudget({ runs: 0, usd: 1.5 }, capOrigin({ max_usd_per_day: 1, usd_per_day_from: 'team' }, repo), 1)).toContain(generic);
        yml('review: [unclosed\n');
        expect(overBudget({ runs: 0, usd: 1.5 }, capOrigin({ max_usd_per_day: 1, usd_per_day_from: 'team' }, repo), 1)).toContain(generic);
    });
});
