import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PullView } from './PullDetail';
import { PullsKpiRow, PullsTable } from './PullsList';
import type { PullDetail, PullRow, PullsList, Round } from './pullsData';

const html = (node: React.ReactElement) => renderToStaticMarkup(node);

const row = (over: Partial<PullRow>): PullRow => ({
    key: '#42', pr: 42, title: 'Retry the charge once', branches: ['feat/checkout'], state: 'merged',
    lastReview: { at: '2026-10-11T10:00:00Z', outcome: 'passed', blocking: 0, shouldFix: 1 }, rounds: 2, lessonsApplied: 1, blockingFound: 2,
    ci: 'success', followUps: { commits: 1, fixes: 1 }, firstAt: '2026-10-10T08:00:00Z', lastActivity: '2026-10-12T08:00:00Z', ...over,
});

const list = (rows: PullRow[], over: Partial<PullsList> = {}): PullsList => ({
    rows, window: { days: 28, reviewed: 1, blocking: 2, lessonsApplied: 1, merged: 1, mergedClean: 1 }, mergesRecorded: true, threadsRecorded: rows.length > 0, scope: { days: 90, older: 0 }, ...over,
});

const round = (over: Partial<Round>): Round => ({
    at: '2026-10-10T10:00:00Z', head: 'a'.repeat(40), trigger: 'review', outcome: 'findings', blocking: 2, shouldFix: 1,
    judges: [{ reviewer: 'claude', model: 'opus', version: null }], recorded: true,
    rules: { served: 4, followed: 2, broken: 1, notApplicable: 1, brokenNames: ['Money is integer cents'] },
    lessons: { served: 2, applied: [{ id: 'L1', text: 'Charge retries carry an idempotency key' }] }, disputed: 0, humanReviews: 2, blind: false,
    cost: [{ usd: 0.48, by: 'claude', basis: 'judge' }], ...over,
});

const detail = (over: Partial<PullDetail['steps']> = {}): PullDetail => ({
    found: true, key: '#42', pr: 42, title: 'Retry the charge once', branches: ['feat/checkout'], state: 'merged', firstAt: '2026-10-10T08:00:00Z', lastAt: '2026-10-12T08:00:00Z',
    steps: {
        brief: null, edits: { at: '2026-10-10T08:05:00Z', checks: 2, findings: 2, files: 1, flagged: 1, cleaned: 1, agents: [] },
        stop: null, push: null, reviews: [round({}), round({ outcome: 'passed', blocking: 0, recorded: false, rules: null, judges: [{ reviewer: 'codex', model: null, version: null }], lessons: { served: null, applied: [] }, cost: [] })],
        human: { reviews: 2, points: [{ lesson: 'Charge retries carry an idempotency key', text: 'Needs a key', author: 'lead@example.com', source: 'person', state: 'verified', at: null }] },
        merge: { at: '2026-10-12T08:00:00Z', sha: 'd'.repeat(40), ci: 'success', followUps: [{ sha: 'e'.repeat(40), at: '2026-10-13T08:00:00Z', subject: 'fix: round the refund', fix: true }], followUpCount: 1, fixes: 1, reverted: null, settled: false, author: 'dev@example.com', source: 'outcomes' },
        ...over,
    },
    facts: { caughtBeforeReview: { findings: 2, stops: 0, pushes: 0 }, repeats: [{ id: 'L1', text: 'Charge retries carry an idempotency key' }], rounds: 2, durationMs: 2 * 86_400_000, judges: [{ reviewer: 'claude', model: 'opus', version: null, runs: 1 }, { reviewer: 'codex', model: null, version: null, runs: 1 }], cost: [{ usd: 0.48, by: 'claude', basis: 'judge' }] },
});

describe('Pull requests page', () => {
    it('lists each pull request with its state, rounds and what happened after the merge', () => {
        const out = html(<PullsTable list={list([row({}), row({ key: 'branch:spike/cache', pr: null, title: null, branches: ['spike/cache'], state: 'not-opened', ci: null, followUps: null })])} onOpen={() => undefined} />);
        expect(out).toContain('#42');
        expect(out).toContain('Retry the charge once');
        expect(out).toContain('Not opened yet');
        expect(out).toContain('spike/cache');
        expect(out).toContain('passed');
        expect(out).toContain('ui-clickable');
        // The first cell is a button, so a keyboard opens the row too.
        expect(out).toContain('<button type="button" class="ui-row-open"><span class="pulls-pr">');
        expect(html(<PullsTable list={list([row({ state: 'no-merge', ci: null, followUps: null })])} onOpen={() => undefined} />)).toContain('No merge recorded');
    });

    it('says when quieter branches are left out of the list', () => {
        expect(html(<PullsTable list={list([row({})], { scope: { days: 90, older: 3 } })} onOpen={() => undefined} />)).toContain('Showing branches with activity in the last 90 days; 3 quieter branches left out.');
        expect(html(<PullsTable list={list([], { scope: { days: 90, older: 1 } })} onOpen={() => undefined} />)).toContain('No pull request with activity in the last 90 days.');
    });

    it('explains an empty list and unknown merges instead of showing zero', () => {
        expect(html(<PullsTable list={list([])} onOpen={() => undefined} />)).toContain('rigour review --reviewer');
        const kpis = html(<PullsKpiRow list={list([], { window: { days: 28, reviewed: 0, blocking: 0, lessonsApplied: 0, merged: 0, mergedClean: 0 }, mergesRecorded: false })} />);
        expect(kpis).toContain('rigour outcomes');
        expect(kpis).not.toContain('>0 of 0<');
        expect(html(<PullsKpiRow list={list([row({})])} />)).toContain('1 of 1');
    });

    it('walks one pull request: each step, the record behind a round, and costs only as reported', () => {
        const out = html(<PullView answer={detail()} onBack={() => undefined} />);
        expect(out).toContain('All pull requests');
        expect(out).toContain('Not recorded on this machine. The brief is recorded');
        expect(out).toContain('agent not recorded');
        expect(out).toContain('Broken: Money is integer cents');
        expect(out).toContain('Repeats a team lesson: Charge retries carry an idempotency key');
        expect(out).toContain('Rules and lessons not recorded here');
        expect(out).toContain('(model not recorded)');
        expect(out).toContain('$0.48 as reported by claude');
        expect(out).toContain('not a bill');
        expect(out).toContain('lead@example.com');
        expect(out).toContain('fix: round the refund');
        expect(out).toContain('2 days');
    });

    it('shows one row per judge across rounds, with its models, runs and its own reported cost, and the total apart', () => {
        const base = detail();
        const facts = { ...base.facts,
            judges: [{ reviewer: 'claude', model: 'opus', version: null, runs: 1 }, { reviewer: 'codex', model: 'gpt-x', version: null, runs: 1 }, { reviewer: 'claude', model: null, version: null, runs: 1 }],
            cost: [{ usd: 0.31, by: 'claude', basis: 'judge' as const }, { usd: 0.12, by: 'codex', basis: 'judge' as const }, { usd: 0.22, by: 'claude', basis: 'all runs' as const }] };
        const out = html(<PullView answer={{ ...base, facts }} onBack={() => undefined} />);
        expect(out.match(/role="row" class="pulls-judge"/g)).toHaveLength(2);
        expect(out).toContain('<strong>claude</strong><small class="pulls-dim">opus, model not recorded</small>');
        expect(out).toMatch(/<span role="cell" class="num">2<\/span><span role="cell" class="num" title="[^"]+">\$0.53<\/span>/);
        expect(out).toContain('<strong>codex</strong><small class="pulls-dim">gpt-x</small>');
        expect(out).toContain('Total reported');
        expect(out).toContain('$0.65');
        expect(out.match(/>Cost</g)).toBeNull();
    });

    it('says how to record a merge, and a pull request it never saw', () => {
        const open = { ...detail({ merge: null, human: { reviews: null, points: [] } }), state: 'no-merge' as const, facts: { ...detail().facts, durationMs: null, cost: [] } };
        const out = html(<PullView answer={open} onBack={() => undefined} />);
        expect(out).toContain('Run <span class="ui-mono">rigour outcomes</span>');
        expect(out).toContain('rigour learn-reviews');
        expect(out).toContain('merge not recorded');
        expect(out).toContain('No merge recorded');
        expect(out).not.toContain('>Open<');
        expect(html(<PullView answer={{ found: false, key: '#404' }} onBack={() => undefined} />)).toContain('Nothing recorded on this machine for #404');
    });
});
