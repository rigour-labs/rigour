import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LearnedRuleRow, SemanticBugs, ruleList, type LearnedRule } from './SemanticBugs';

const rule: LearnedRule = {
    id: 'require-option-redirect-d3cf9986',
    template: 'require-option',
    requirement: '`redirect` in argument 2',
    appliesTo: 'declaration scripts/http.ts#HttpDeps.fetch',
    message: 'm',
    severity: 'medium',
    source: { commit: 'f44192fbf1963be7', file: 'scripts/http.ts', function: 'fetchWithRetry' },
    validation: { firesBefore: 1, firesAfter: 0, maxHits: 3, repoHits: [] },
};

describe('SemanticBugs', () => {
    it('shows the gate state and the configured built-in rules', () => {
        const html = renderToStaticMarkup(<SemanticBugs enabled rules="[credential-redirect]" />);
        expect(html).toContain('Semantic Bugs');
        expect(html).toContain('credential-redirect');
        expect(html).not.toContain('in-memory-aggregation');
    });

    it('shows a learned rule with its source fix and validation', () => {
        const html = renderToStaticMarkup(<LearnedRuleRow rule={rule} />);
        expect(html).toContain('Requires <code>redirect</code> in argument 2');
        expect(html).toContain('f44192fb · scripts/http.ts (fetchWithRetry)');
        expect(html).toContain('fires 1× before the fix, 0× after · 0 other hit(s), max 3');
    });

    it('reads rules as an array or the flow-style string the config parser keeps', () => {
        expect(ruleList(['a'])).toEqual(['a']);
        expect(ruleList("[credential-redirect, 'in-memory-aggregation']")).toEqual(['credential-redirect', 'in-memory-aggregation']);
        expect(ruleList(undefined)).toEqual([]);
    });
});
