import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { stageHints, WhileWritingBody, type DevelopmentData } from './WhileWritingParts';

type FeedItem = DevelopmentData['feed'][number];

const html = (node: React.ReactElement) => renderToStaticMarkup(node).replace(/\s+/g, ' ');

const data: DevelopmentData = {
    window: { from: '2026-10-02T12:00:00Z', to: '2026-10-09T12:00:00Z', days: 7 },
    recordingSince: '2026-09-01T00:00:00Z',
    stages: {
        brief: { briefings: 2, sessions: 1, told: 5, onRequest: 3 },
        edits: { checked: 40, withFindings: 4, blocked: null },
        stop: { reviews: 6, blocked: 2, nothingToReview: 1, fixedBeforeDone: 2 },
        push: { runs: 0, passed: 0, failed: 0 },
    },
    caught: { total: 6, fixedByAgent: 5, stillOpen: 1, medianMinutesToFix: 4, byStage: { edit: 3, review: 1, stop: 2, pr: 0 } },
    topRules: [{ rule: 'security-patterns', title: 'Stripe key in `pay.ts`', caught: 3, fixed: 2 }],
    byAgent: [
        { agent: 'claude', briefings: 2, editsChecked: 0, editsWithFindings: 0, stopReviews: 6, sentBack: 2, pushes: null },
        { agent: null, briefings: 0, editsChecked: 40, editsWithFindings: 4, stopReviews: 0, sentBack: 0, pushes: 0 },
    ],
    recentFixes: [{ id: 's', at: '2026-10-09T10:00:00Z', stage: 'stop', file: 'src/pay.ts', rule: 'missing-test', title: 'No test for `refund`', diff: ['+it()'] }],
    open: [{ file: 'src/cart.ts', rule: 'any', title: 'Untyped any', openedAt: '2026-10-09T11:00:00Z', stage: 'edit' }],
    feed: [],
};

const item = (at: string, fields: Partial<FeedItem> = {}): FeedItem => ({ at, stage: 'edit', branch: 'feat/pay', agent: null, session: null, text: 'Reported 1 problem on an edit to src/a.ts', tone: 'warn', ...fields });

describe('While writing', () => {
    it('leads with the four numbers, saying how fast the agent fixed and how often "done" was sent back', () => {
        const out = html(<WhileWritingBody data={data} hints={{}} />);
        expect(out.match(/<span class="ui-label">[^<]+<\/span><span class="ui-kpi-value">\d+/g)).toEqual([
            '<span class="ui-label">Edits checked</span><span class="ui-kpi-value">40',
            '<span class="ui-label">Caught while writing</span><span class="ui-kpi-value">6',
            '<span class="ui-label">Fixed by the agent</span><span class="ui-kpi-value">5',
            '<span class="ui-label">Sent back at &quot;done&quot;</span><span class="ui-kpi-value">2',
        ]);
        const median = (m: number | null) => html(<WhileWritingBody data={{ ...data, caught: { ...data.caught, medianMinutesToFix: m } }} hints={{}} />);
        expect(median(4)).toContain('median 4 minutes from report to fix');
        expect(median(0)).toContain('median under a minute from report to fix');
        expect(median(1064)).toContain('median 18 hours from report to fix');
        expect(median(4000)).toContain('median 3 days from report to fix');
        expect(median(null)).toContain('time to fix not recorded');
    });

    it('draws the four stages in order, says blocks were not recorded rather than zero, and how to fill an empty stage', () => {
        const out = html(<WhileWritingBody data={data} hints={{}} />);
        expect(out.indexOf('Briefed')).toBeLessThan(out.indexOf('Checked'));
        expect(out.indexOf('Agent said done')).toBeLessThan(out.indexOf('Push checks'));
        expect(out).toContain('4 edits with a finding · blocks not recorded');
        expect(out).toContain('2 sent back · 2 problems fixed before it stopped');
        expect(out).toContain('<code class="st-mono st-inline-code">rigour hooks init</code> adds git');
    });

    it('names the setup step when the edit or stop hook is missing', () => {
        const hints = stageHints([{ id: 'stop', state: 'missing', fix: 'rigour setup' }, { id: 'edit', state: 'working' }]);
        expect(hints).toEqual({ stop: 'The review when an agent says done is not set up in this repository: run `rigour setup`.' });
        const out = html(<WhileWritingBody data={{ ...data, stages: { ...data.stages, stop: { reviews: 0, blocked: 0, nothingToReview: null, fixedBeforeDone: 0 } } }} hints={hints} />);
        expect(out).toContain('The review when an agent says done is not set up in this repository: run <code');
    });

    it('lists agents only where recorded, and pushes as a dash on a named agent', () => {
        const out = html(<WhileWritingBody data={data} hints={{}} />);
        expect(out).toContain('<th>claude</th><th>not recorded</th>');
        expect(out).toMatch(/sent back<\/span><\/td><td[^>]*>2<\/td><td[^>]*>0<\/td>/);
        expect(out).toMatch(/Pushes<\/span><\/td><td[^>]*>—<\/td><td[^>]*>0<\/td>/);
        expect(out).toContain('the push check never does');
    });

    it('groups the feed into stretches of work, with the branch and the agents named in each', () => {
        const items = [item('2026-10-09T11:00:00Z', { agent: 'claude' }), item('2026-10-09T10:30:00Z'), item('2026-10-09T08:00:00Z', { branch: null })];
        const out = html(<WhileWritingBody data={{ ...data, feed: items }} hints={{}} />);
        expect(out.match(/class="ww-session"/g)).toHaveLength(2); // a gap of over 45 minutes starts a new stretch
        expect(out).toContain('feat/pay · claude');
        expect(out).toContain('agent not recorded');
    });

    it('never calls an edit that was only reported a block', () => {
        const out = html(<WhileWritingBody data={{ ...data, stages: { ...data.stages, edits: { ...data.stages.edits, blocked: 0 } }, feed: [item('2026-10-09T11:00:00Z')] }} hints={{}} />);
        const feed = out.slice(out.indexOf('What happened'), out.indexOf('Caught most often'));
        expect(feed).toContain('>edit<');
        expect(feed).not.toMatch(/blocked|Blocked/);
    });

    it('shows the fix with its stage, the rules caught, what is still open, and how far the record goes back', () => {
        const out = html(<WhileWritingBody data={data} hints={{}} />);
        expect(out).toContain('No test for <code class="st-mono st-inline-code">refund</code>');
        expect(out).toContain('before the agent said done');
        expect(out).toContain('2 of 3 fixed');
        expect(out).toContain('Untyped any');
        expect(out).toContain('Nothing happened in this window.');
        expect(out).toContain('Recording since');
    });
});
