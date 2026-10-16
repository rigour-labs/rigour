import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DecisionsCard } from './GovernanceParts';
import type { Decision } from './governanceData';

const html = (node: React.ReactElement) => renderToStaticMarkup(node);
const UNNAMED_NOTE = 'Who decided is recorded once the team database has the 7.0.11 rules; older decisions show no name.';

const decision = (i: number, over: Partial<Decision> = {}): Decision => ({
    at: new Date(Date.UTC(2026, 9, 15) - i * 3_600_000).toISOString(), who: null, kind: i % 3 ? 'Shared with the team' : 'Not a bug',
    text: `checkout.retry_${i}: Retry the payment call twice with backoff, then fail the checkout with a message the shopper can act on.`, reason: null, source: 'team lessons', ...over,
});

describe('the decisions log', () => {
    const many = Array.from({ length: 130 }, (_, i) => decision(i));

    it('says once that names were not recorded, never on each row, and pages the log', () => {
        const out = html(<DecisionsCard decisions={many} />);
        expect(out).toContain(UNNAMED_NOTE);
        expect(out).not.toContain('not recorded');
        expect(out).not.toContain('no reason given');
        expect(out).toContain('1–25 of 130');
        expect(out.match(/ui-list-row gov-decision/g)).toHaveLength(25);
        expect(out).toContain('class="ui-memkey" title="checkout.retry_0">checkout.retry_0<');
        expect(out).toContain('-webkit-line-clamp:1');
    });

    it('shows who and why only where recorded, and no note when most rows name someone', () => {
        const named = [decision(0, { who: 'reviewer-a', reason: 'one-off' }), decision(1, { who: 'dev-a' }), decision(2)];
        const out = html(<DecisionsCard decisions={named} />);
        expect(out).toContain('by reviewer-a · why: one-off');
        expect(out).not.toContain(UNNAMED_NOTE);
    });

    it('offers a chip per kind with its count, and searches text, who and why', () => {
        const out = html(<DecisionsCard decisions={many} />);
        expect(out).toContain('>Not a bug<span class="ui-filterchip-count">44</span>');
        const found = html(<DecisionsCard decisions={many} initialQuery="retry_12:" />);
        expect(found).toContain('1 decision<');
        expect(found.match(/ui-list-row gov-decision/g)).toHaveLength(1);
    });
});
