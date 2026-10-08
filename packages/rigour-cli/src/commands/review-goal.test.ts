import { describe, expect, it } from 'vitest';
import { parseGoal } from '@rigour-labs/core';
import { goalReport } from './review-goal.js';

const on = { enabled: true, source: 'flag' as const, required: false, refused: [] };

describe('goalReport', () => {
    it('records what the description declared when the check ran', () => {
        const goal = parseGoal('## Scope\n- `src/`\n\n## Out of scope\n- `docs/`\n\n## Done when\n- `run` is called');
        expect(goalReport(on, 'body', { goal })).toEqual({ ...on, declared: true, scope: ['src/'], out_of_scope: ['docs/'], done_when: 1 });
    });

    it('says why a check that is on checked nothing', () => {
        expect(goalReport(on, undefined, {}).reason).toContain('no pull request description');
        expect(goalReport(on, 'Just a fix.', {}).reason).toContain('declares no Scope');
    });

    it('carries the refusals of a team floor, and no reason when the check is off', () => {
        const refused = { enabled: true, source: 'team' as const, required: true, refused: ['goal check off (flag) refused: rigour.yml sets review.goal: required'] };
        expect(goalReport(refused, 'Just a fix.', {}).refused).toEqual(refused.refused);
        expect(goalReport({ ...on, enabled: false }, undefined, {})).toEqual({ ...on, enabled: false, declared: false });
    });
});
