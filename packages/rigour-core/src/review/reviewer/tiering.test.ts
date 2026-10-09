import { describe, expect, it } from 'vitest';
import type { ReviewCost } from './store.js';
import { chooseTier, type TierFacts } from './tiering.js';

const quiet: TierFacts = { required: false, humanReviews: 0, carried: 0, migration: false, securityChecks: 0, goal: false, risky: 0 };
const row = (actualUsd: number, tier: ReviewCost['tier'] = 'cheap'): ReviewCost => ({ at: '', mode: 'single', lines: 10, projectedSingleChars: 1000, actualChars: 1000, actualUsd, runs: 1, tier });
const baseline = { at: '', usdPerChar: 0.001, singles: 5 };

describe('cheap-model-first tiering', () => {
    it('is off without a cheap model for the judge', () => {
        expect(chooseTier({}, 'claude', quiet, [], undefined)).toBeUndefined();
        expect(chooseTier({ codex: 'mini' }, 'claude', quiet, [], undefined)).toBeUndefined();
    });

    it('gives a change with no risk signal the cheap model, and any signal the team\'s', () => {
        expect(chooseTier({ claude: 'haiku' }, 'claude', quiet, [], undefined)).toEqual({ tier: 'cheap', model: 'haiku', why: 'no risk signal: the cheap model' });
        const signals: Array<[Partial<TierFacts>, string]> = [
            [{ required: true }, 'a required floor'], [{ humanReviews: 2 }, '2 human review(s) to check'], [{ carried: 1 }, '1 open item(s) carried'],
            [{ migration: true }, 'migration'], [{ securityChecks: 1 }, 'security finding'], [{ goal: true }, 'goal'],
            [{ risky: undefined }, 'could not score'], [{ risky: 3 }, '3 risky changed function(s)'],
        ];
        for (const [facts, why] of signals) {
            const decision = chooseTier({ claude: 'haiku' }, 'claude', { ...quiet, ...facts }, [], undefined);
            expect(decision?.tier, why).toBe('strong');
            expect(decision?.why).toContain(why);
        }
    });

    it('turns itself off when its recent reviews cost more, on average, than one judge would have, and not before five', () => {
        expect(chooseTier({ claude: 'haiku' }, 'claude', quiet, Array.from({ length: 4 }, () => row(2)), baseline)?.tier).toBe('cheap');
        const over = chooseTier({ claude: 'haiku' }, 'claude', quiet, [...Array.from({ length: 5 }, () => row(1.5)), { ...row(9), tier: undefined }] /* an untiered review is not counted */, baseline);
        expect(over).toMatchObject({ tier: 'strong', disabled: 'the last 5 tiered reviews cost 1.50x what one judge would have (dollars)' });
        expect(chooseTier({ claude: 'haiku' }, 'claude', quiet, Array.from({ length: 10 }, (_, i) => row(i % 2 ? 1.2 : 0.4)), baseline)?.tier).toBe('cheap'); // 0.8x on average
    });
});
