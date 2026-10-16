import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CoverageCard, DecisionsCard } from './GovernanceParts';
import { FixCommand } from './ui';
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
        expect(out).not.toContain('Show more');
        expect(out.match(/role="button" tabindex="0" aria-expanded="false"/g)).toHaveLength(25);
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

describe('coverage with nothing switched on', () => {
    const empty = { stages: ['edit', 'stop'] as const, rows: [], unattributed: { edit: null, stop: null }, covered: 0, possible: 0 } as any;
    const fixes = [{ name: 'Checks your agent as it writes', fix: 'rigour setup' }];

    it('is one summary row with Setup, and what to run behind a disclosure, so the decisions log stays in view', () => {
        const out = html(<CoverageCard coverage={empty} fixes={fixes} onSetup={() => undefined} />);
        expect(out).toContain('Hooks not set up for any agent');
        expect(out).toContain('aria-expanded="false" aria-controls="gov-coverage-fixes">What to run (1)</button>');
        expect(out).toContain('>Open Setup</button>');
        expect(out).not.toContain('<table');
        expect(out).not.toContain('rigour setup</code>');
    });

    it('shows a fix command on one line with Copy, and the home folder as ~', () => {
        const mcp = [{ name: 'Rigour tools for agents (MCP)', fix: 'claude mcp add --scope user rigour -- node /Users/dev-a/work/acme/packages/rigour-mcp/dist/index.js' }];
        const out = html(<CoverageCard coverage={empty} fixes={mcp} onSetup={() => undefined} />).replace(/<\/?section[^>]*>/g, '');
        expect(out).not.toContain('/Users/dev-a');
        expect(html(<FixCommand command={mcp[0].fix} />)).toContain('title="claude mcp add --scope user rigour -- node ~/work/acme/packages/rigour-mcp/dist/index.js"');
        expect(html(<FixCommand command="rigour setup" />)).toContain('>Copy</button>');
        expect(html(<FixCommand command={'node C:\\Users\\dev-a\\x.js and /home/dev-b/y.js'} />)).toContain('title="node ~\\x.js and ~/y.js"');
    });
});
