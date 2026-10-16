import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { GovernanceView } from './GovernanceView';
import { DecisionsCard } from './GovernanceParts';
import { ReviewerUsageCard, TeamCard } from './GovernanceSide';
import type { GovernanceData } from './governanceData';
import { WeekView } from './WeekView';
import { RecentPullsCard, RepeatsChart, type WeekData } from './WeekParts';

const html = (node: React.ReactElement) => renderToStaticMarkup(node);
/** Each KPI card's label and value, in order, as the page renders them. */
const kpis = (out: string) => [...out.matchAll(/<span class="ui-label">([^<]*)<\/span><span class="ui-kpi-value">([^<]*)<\/span>/g)].map(m => [m[1], m[2]]);
const at = new Date(Date.now() - 2 * 3600_000).toISOString();
const cell = (configured: 'on' | 'off' | 'not checked' | 'no hooks' | null, seen: string | null = null) => ({ configured, seen });

const governance = (patch: Partial<GovernanceData> = {}): GovernanceData => ({
    coverage: {
        stages: ['brief', 'edit', 'stop', 'push', 'pr'],
        rows: [
            { agent: 'Claude Code', cells: { brief: cell('not checked'), edit: cell('on', at), stop: cell('on'), push: cell('off'), pr: cell('on') } },
            { agent: 'Codex', note: 'Codex has no hooks.', cells: { brief: cell('no hooks'), edit: cell('no hooks'), stop: cell('no hooks'), push: cell('off'), pr: cell('on') } },
        ],
        unattributed: { brief: null, edit: null, stop: null, push: at, pr: null },
        covered: 4, possible: 9,
    },
    fixes: [{ name: 'Push gate', state: 'missing', fix: 'rigour hooks init' }],
    decisions: [
        { at, who: 'lead@acme.example.com', kind: 'Lesson accepted', text: 'Close the `handle`', reason: 'seen twice', pr: 4, source: 'review lessons' },
        { at, who: null, kind: 'Not a bug', text: 'file-size', reason: null, source: 'not a bug' },
    ],
    decisionsRecent: 2,
    qualityGates: { configFile: null, reportOnly: { on: true, setBy: 'team' }, rules: [{ name: 'File length', setting: '500 lines', blocks: false }], commands: [], score: [{ at, score: 70, status: 'PASS' }, { at, score: 82, status: 'PASS' }], pushes: null },
    reviewer: { days: [], runs: 0, judges: [], deep: null, caps: { runsPerDay: 40, usdPerDay: 10, usdPerReview: 2 } },
    team: { sync: false, organization: null, team: null, actor: null, sharing: null, received: 0 },
    ...patch,
});

describe('Governance', () => {
    it('leads with coverage, decisions, review runs and the score, a dash where nothing is recorded', () => {
        expect(kpis(html(<GovernanceView data={governance()} onSetup={() => undefined} />))).toEqual([
            ['Moments covered', '4/9'], ['Decisions, 28 days', '2'], ['Review runs, 28 days', '—'], ['Quality score', '82'],
        ]);
    });

    it('shows the coverage matrix with an "agent not recorded" row and the fixes to run', () => {
        const out = html(<GovernanceView data={governance()} onSetup={() => undefined} />);
        expect(out).toContain('Agent not recorded');
        expect(out).toContain('Codex has no hooks.');
        expect(out).toContain('no hooks');
        expect(out).toContain('rigour hooks init');
        expect(out).toContain('only report, set by the team');
        expect(out).toContain('Rigour&#x27;s defaults (no rigour.yml)');
        expect(out).toContain('Teammates&#x27; candidates are visible only to them until shared.');
    });

    it('says who decided only where it was recorded, and offers a filter per kind', () => {
        const out = html(<DecisionsCard decisions={governance().decisions} />);
        expect(out).toContain('by lead@acme.example.com');
        expect(out).toContain('who decided: not recorded');
        expect(out).toContain('PR #4');
        expect(out).toContain('>Not a bug 1</button>');
        expect(out).toContain('aria-pressed="true">All');
        expect(html(<DecisionsCard decisions={[]} />)).toContain('No decisions recorded yet');
    });

    it('labels dollars as reported by the judge and a subscription figure as no bill', () => {
        const usage = { days: [{ day: '2026-10-14', runs: 4, usd: 2.29 }], runs: 4, deep: null, caps: { runsPerDay: 40, usdPerDay: 10, usdPerReview: 2 },
            judges: [{ reviewer: 'claude', model: null, version: '2.1', reviews: 4, costUsd: 2.29, pricedReviews: 4, tokens: { input: 1_679_472, output: 32_018 } },
                { reviewer: 'codex', model: 'gpt-x', version: null, reviews: 1, costUsd: null, pricedReviews: 0, tokens: null }] };
        const out = html(<ReviewerUsageCard usage={usage} />);
        expect(out).toContain('$2.29 as reported by claude');
        expect(out).toContain('not a bill');
        expect(out).toContain('1.7M in / 32k out');
        expect(out).toContain('No dollars reported.');
        expect(out).toContain('tokens not recorded');
        expect(html(<ReviewerUsageCard usage={governance().reviewer} />)).toContain('No reviewer runs in the last 28 days');
        expect(out).toContain('rigour.yml&#x27;s caps');
        expect(out).toContain('~/.rigour/settings.json can lower');
    });

    it('shows a team member why their decisions stay on this machine', () => {
        const out = html(<TeamCard team={{ sync: true, organization: 'acme', team: 'web', actor: 'dev', sharing: { shares: false, reason: 'members do not share' }, received: 3 }} />);
        expect(out).toContain('kept on this machine');
        expect(out).toContain('members do not share');
    });
});

const week: WeekData = {
    recordingSince: '2026-09-01T00:00:00Z',
    needs: [{ key: 'abcdef0123456789', file: 'src/a.ts', rule: 'file-size', title: 'Function is 120 lines long', openedAt: at, stage: 'edit' }],
    stories: [{ id: 's', at, stage: 'edit', file: 'src/b.ts', rule: 'security-patterns', title: 'Hardcoded key', diff: ['-a', '+b'] }],
    stopped: { total: 3, fixed: 2, byStage: { edit: 2, review: 0, stop: 1, pr: 0 } },
    agentSaidDone: 1, raised: 4, overruled: 1, reviews: null,
};
const weeks = [{ from: '2026-09-25T00:00:00Z', repeatsStopped: 1, repeatsReachedPr: null }, { from: '2026-10-02T00:00:00Z', repeatsStopped: 2, repeatsReachedPr: null }];

describe('This week', () => {
    it('leads with what was stopped, fixed and repeated, and a dash for reviews never recorded', () => {
        const view = (data: WeekData, w: typeof weeks | null) => kpis(html(<WeekView data={data} weeks={w} intro={false} onHideIntro={() => undefined} onDone={() => undefined} onNavigate={() => undefined} />));
        expect(view(week, weeks)).toEqual([
            ['Stopped before a PR', '3'], ['Fixed by the agent', '2'], ['Repeats prevented', '2'], ['Reviews run', '—'], ['Needs you', '1'],
        ]);
        expect(view({ ...week, reviews: 0 }, null).slice(2, 4)).toEqual([['Repeats prevented', '—'], ['Reviews run', '0']]);
    });

    it('keeps the intro, the needs queue with dismiss and recheck, the stories and the copy summary', () => {
        const out = html(<WeekView data={week} weeks={weeks} intro onHideIntro={() => undefined} onDone={() => undefined} onNavigate={() => undefined} />);
        expect(out).toContain('How Rigour works');
        expect(out).toContain('1 finding needs you.');
        expect(out).toContain('Check these again');
        expect(out).toContain('It&#x27;s fine, not a bug');
        expect(out).toContain('Hardcoded key');
        expect(out).toContain('Copy this week');
        expect(out).toContain('Setup gaps');
    });

    it('charts repeats, and says when reaching a PR is not recorded instead of drawing zeros', () => {
        const out = html(<RepeatsChart weeks={weeks} />);
        expect(out).toContain('Repeats caught while writing');
        expect(out).not.toContain('Repeats that reached a PR</span>');
        expect(out).toContain('not recorded here');
        expect(html(<RepeatsChart weeks={[{ ...weeks[0], repeatsReachedPr: 1 }]} />)).toContain('Repeats that reached a PR');
    });

    it('lists recent pull requests when the endpoint has them', () => {
        const out = html(<RecentPullsCard rows={[{ key: '#12', pr: 12, title: 'Add retries', branches: ['feat/retries'], state: 'no-merge', lastReview: { at, outcome: 'findings', blocking: 2, shouldFix: 1 }, rounds: 1, lessonsApplied: 0, blockingFound: 2, ci: null, followUps: null, firstAt: at, lastActivity: at }]} onOpen={() => undefined} />);
        expect(out).toContain('#12');
        expect(out).toContain('found problems · 2 blocking');
    });
});
