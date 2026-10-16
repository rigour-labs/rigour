import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigSchema, type ThreadEvent } from '@rigour-labs/core';
import { buildCoverage } from './studio-governance-coverage.js';
import { buildDecisions, byPerson } from './studio-governance-decisions.js';
import { buildQualityGates } from './studio-governance-gates.js';
import { reviewerUsage, teamState } from './studio-governance-usage.js';
import { loadGovernance } from './studio-governance.js';

const now = new Date('2026-10-09T12:00:00Z');
const thread = (kind: ThreadEvent['kind'], at: string, extra: Record<string, unknown> = {}): ThreadEvent => ({ kind, at, task: 'branch:main', branch: 'main', ...extra });
const temps: string[] = [];
const temp = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rigour-gov-')); temps.push(dir); return dir; };
afterEach(() => { for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe('governance coverage', () => {
    const agents = [
        { name: 'Claude Code', config: '{"hooks":{"PostToolUse":"rigour hooks check","Stop":"rigour hooks stop"}}' },
        { name: 'Cursor', config: '{"afterFileEdit":"rigour hooks check $TOOL_INPUT_file_path"}' },
    ];

    it('says per agent what is switched on and when it last fired, and never names an agent the record does not', () => {
        const coverage = buildCoverage({
            now, agents, codex: true, pushGate: true, prReviewer: 'off', events: [],
            threads: [
                thread('stop-review', '2026-10-08T10:00:00Z', { agent: 'claude' }),
                thread('edit-check', '2026-10-08T11:00:00Z', { agent: 'cursor' }),
                thread('edit-check', '2026-10-08T12:00:00Z'),
                thread('brief', '2026-10-08T09:00:00Z', { agent: 'cli' }),
                thread('push', '2026-10-07T09:00:00Z', { passed: true }),
                thread('stop-review', '2026-08-01T10:00:00Z', { agent: 'claude' }), // older than 28 days
                thread('edit-check', '2026-10-01T10:00:00Z', { agent: 'bot-7' }),
            ],
        });
        const claude = coverage.rows.find(r => r.agent === 'Claude Code')!;
        expect(claude.cells.edit).toEqual({ configured: 'on', seen: null });
        expect(claude.cells.stop).toEqual({ configured: 'on', seen: '2026-10-08T10:00:00Z' });
        expect(claude.cells.brief.configured).toBe('not checked');
        const cursor = coverage.rows.find(r => r.agent === 'Cursor')!;
        expect(cursor.cells.edit).toEqual({ configured: 'broken', seen: '2026-10-08T11:00:00Z' });
        expect(cursor.cells.stop.configured).toBe('off');
        expect(coverage.rows.find(r => r.agent === 'Codex')!.cells.edit.configured).toBe('no hooks');
        expect(coverage.rows.find(r => r.agent === 'bot-7')!.cells.edit).toEqual({ configured: null, seen: '2026-10-01T10:00:00Z' });
        expect(coverage.unattributed).toMatchObject({ brief: '2026-10-08T09:00:00Z', edit: '2026-10-08T12:00:00Z', push: '2026-10-07T09:00:00Z', pr: null, stop: null });
        // Claude: edit, stop, push on; Cursor: push on; Codex: push on. Of 4 + 4 + 5: the brief is not checked, the bot has nothing to count.
        expect([coverage.covered, coverage.possible]).toEqual([5, 13]);
    });

    it('reads the event log only where no thread was kept', () => {
        const coverage = buildCoverage({
            now, agents, codex: false, pushGate: false, prReviewer: 'off', threads: [],
            events: [{ type: 'stop_review', tool: 'cursor', timestamp: '2026-10-08T10:00:00Z' }, { type: 'hook_check', timestamp: '2026-10-08T11:00:00Z' }],
        });
        expect(coverage.rows.find(r => r.agent === 'Cursor')!.cells.stop.seen).toBe('2026-10-08T10:00:00Z');
        expect(coverage.unattributed.edit).toBe('2026-10-08T11:00:00Z');
    });

    it('shows a known agent seen here without a hook config as switched off', () => {
        const coverage = buildCoverage({ now, agents: [], codex: false, pushGate: false, prReviewer: 'off', events: [], threads: [thread('brief', '2026-10-08T09:00:00Z', { agent: 'claude' })] });
        expect(coverage.rows).toEqual([expect.objectContaining({ agent: 'Claude Code', cells: expect.objectContaining({ brief: { configured: 'not checked', seen: '2026-10-08T09:00:00Z' }, edit: { configured: 'off', seen: null } }) })]);
    });

    it('shows a pull-request reviewer setup reports broken as broken, not on', () => {
        const coverage = buildCoverage({ now, agents, codex: false, pushGate: false, prReviewer: 'broken', events: [], threads: [] });
        expect(coverage.rows.map(r => r.cells.pr.configured)).toEqual(['broken', 'broken']);
    });
});

describe('governance decisions', () => {
    it('merges every decision store newest first, with who only where it was recorded', () => {
        const lesson = { id: 'l1', text: 'Close the handle', file: 'a.ts', symbols: [], state: 'verified' as const, createdAt: '', updatedAt: '', evidence: [
            { kind: 'point' as const, pr: 3, comment: 'c', author: 'dev@acme.example.com', at: '2026-10-01T00:00:00Z' },
            { kind: 'accepted' as const, pr: 3, comment: 'd', author: 'lead@acme.example.com', detail: 'seen twice', at: '2026-10-02T00:00:00Z' },
            { kind: 'compiled' as const, pr: 3, comment: 'e', author: 'lead@acme.example.com', at: '2026-10-03T00:00:00Z' },
        ] };
        const decisions = buildDecisions({
            lessons: [lesson],
            dismissals: [{ key: 'k', reason: 'intended', at: '2026-10-04T00:00:00Z', check: 'file-size' }],
            reviewDismissals: [{ class: 'correctness', issue: 'maybe null', file: 'b.ts', line: 4, reason: 'guarded above', at: '2026-10-05T00:00:00Z', by: 'dev@acme.example.com' }],
            compiled: [{ id: 'c1', lessonId: 'l1', files: 'a.ts', kind: 'forbid', symbol: 'open', message: 'Close the handle', state: 'active', at: '2026-10-03T00:00:00Z', history: [{ state: 'active', by: 'lead@acme.example.com', at: '2026-10-03T00:00:00Z' }] }],
            events: [
                { type: 'interception_requested', requestId: 'r1', command: 'rm -rf build', timestamp: '2026-10-06T00:00:00Z' } as never,
                { type: 'x', tool: 'human_arbitration', requestId: 'r1', decision: 'approve', arbitrated: true, timestamp: '2026-10-06T00:01:00Z' } as never,
            ],
            team: { version: 1, sharing: { shares: true }, mine: {}, decisions: [
                { id: 't1', lessonId: 'l2', kind: 'rejected', name: 'reviewer-a', decidedAt: '2026-10-07T00:00:00Z', receivedAt: '2026-10-07T00:00:00Z', detail: 'not our style', text: 'Use tabs', points: [{ pr: 9, comment: 'x', source: 'person' }] },
                { id: 't2', lessonId: 'l1', kind: 'accepted', decidedAt: '2026-10-02T00:00:00Z', receivedAt: '2026-10-02T00:00:00Z', detail: 'seen twice', points: [] },
            ] },
        });
        expect(decisions.map(d => [d.kind, d.who, d.source])).toEqual([
            ['Lesson rejected', 'reviewer-a', 'team'],
            ['Command approved', null, 'Studio approval'],
            ['Reviewer finding dismissed', 'dev@acme.example.com', 'reviewer'],
            ['Not a bug', null, 'not a bug'],
            ['Check approved', 'lead@acme.example.com', 'compiled checks'],
            ['Lesson accepted', 'lead@acme.example.com', 'review lessons'],
        ]);
        expect(decisions[1].text).toBe('rm -rf build');
        expect(decisions.every(byPerson)).toBe(true);
        expect(decisions[5]).toMatchObject({ reason: 'seen twice', pr: 3, text: 'Close the handle' });
    });
});

describe('governance quality rules', () => {
    it('says what blocks, keeps the last 30 scores and counts pushes held', () => {
        const config = ConfigSchema.parse({ gates: { max_file_lines: 400, file_size: { block: true } }, hooks: { report_only: true } });
        const scores = Array.from({ length: 35 }, (_, i) => ({ timestamp: `2026-10-0${1 + (i % 9)}T${String(i % 24).padStart(2, '0')}:00:00Z`, status: 'PASS' as const, score: 60 + i, failureCount: 0, severity_breakdown: {}, provenance_breakdown: {} }));
        const gates = buildQualityGates({ now, config, configFile: 'rigour.yml', personalReportOnly: false, scores, threads: [thread('push', '2026-10-08T00:00:00Z', { passed: false }), thread('push', '2026-10-08T01:00:00Z', { passed: true })] });
        expect(gates.reportOnly).toEqual({ on: true, setBy: 'team' });
        expect(gates.rules[0]).toEqual({ name: 'File length', setting: '400 lines', blocks: true });
        expect(gates.score).toHaveLength(30);
        expect(gates.pushes).toEqual({ passed: 1, held: 1 });
        expect(buildQualityGates({ now, config: ConfigSchema.parse({}), configFile: null, personalReportOnly: true, scores: [], threads: [] })).toMatchObject({ reportOnly: { on: true, setBy: 'this clone' }, pushes: null });
    });
});

describe('governance reviewer usage', () => {
    it('counts runs per day, judges by model with their own tokens, and dollars only as reported', () => {
        const store = temp();
        fs.mkdirSync(path.join(store, 'spend'));
        fs.writeFileSync(path.join(store, 'spend', '2026-10-08.jsonl'), '{"runs":1,"usd":0.5}\n{"runs":2}\n');
        fs.writeFileSync(path.join(store, 'spend', '2026-10-07.jsonl'), '{"runs":1}\n');
        fs.writeFileSync(path.join(store, 'spend', '2026-08-01.jsonl'), '{"runs":9}\n');
        fs.writeFileSync(path.join(store, 'abc.f1.record.json'), JSON.stringify({ at: '2026-10-08T00:00:00Z', judges: [{ reviewer: 'claude', version: '2.1', cost_usd: 0.5 }, { reviewer: 'codex', model: 'gpt-x' }] }));
        fs.writeFileSync(path.join(store, 'abc.f1.json'), JSON.stringify({ reviewers: [{ reviewer: 'claude', tokens: { input: 100, output: 10 } }] }));
        const usage = reviewerUsage(store, [{ enabled: true, at: '2026-10-08T00:00:00Z', model: 'm', input_tokens: 5, output_tokens: 1 }], ConfigSchema.parse({}), now);
        expect(usage.days).toEqual([{ day: '2026-10-07', runs: 1, usd: null }, { day: '2026-10-08', runs: 3, usd: 0.5 }]);
        expect(usage.runs).toBe(4);
        expect(usage.judges.find(j => j.reviewer === 'claude')).toMatchObject({ costUsd: 0.5, tokens: { input: 100, output: 10 }, version: '2.1' });
        expect(usage.judges.find(j => j.reviewer === 'codex')).toMatchObject({ costUsd: null, model: 'gpt-x', tokens: null });
        expect(usage.deep).toMatchObject({ runs: 1, costUsd: null, unpricedRuns: 1, models: ['m'] });
        expect(reviewerUsage(undefined, [], ConfigSchema.parse({}), now)).toMatchObject({ days: [], judges: [], deep: null });
    });

    it('counts the review runs, judges and reported dollars the threads recorded, with no spend log, once per review', () => {
        const store = temp();
        fs.writeFileSync(path.join(store, 'h1.f1.record.json'), JSON.stringify({ at: '2026-10-08T00:00:00Z', head: 'h1', judges: [{ reviewer: 'claude', model: 'opus', cost_usd: 0.4 }] }));
        const review = (at: string, over: Record<string, unknown>) => ({ at, task: 'branch:feat/x', branch: 'feat/x', kind: 'review', outcome: 'passed', ...over }) as never;
        const threads = [
            review('2026-10-08T10:00:00Z', { head: 'h1', judges: ['claude'], cost_usd: 0.4 }), // has a record: counted from it
            review('2026-10-08T12:00:00Z', { head: 'h2', judges: ['claude'], cost_usd: 0.25 }),
            review('2026-10-09T09:00:00Z', { head: 'h3', judges: ['claude', 'codex'], cost_usd: 0.6 }),
            review('2026-08-01T09:00:00Z', { head: 'h0', judges: ['claude'] }), // outside the window
            { at: '2026-10-09T09:30:00Z', task: 'branch:feat/x', branch: 'feat/x', kind: 'push' } as never,
        ];
        const usage = reviewerUsage(store, [], ConfigSchema.parse({}), now, threads);
        expect(usage.days).toEqual([{ day: '2026-10-08', runs: 2, usd: 0.65 }, { day: '2026-10-09', runs: 1, usd: 0.6 }]);
        expect(usage.runs).toBe(3);
        expect(usage.judges.find(j => j.reviewer === 'claude' && j.model === 'opus')).toMatchObject({ reviews: 1, costUsd: 0.4 });
        expect(usage.judges.find(j => j.reviewer === 'claude' && j.model === null)).toMatchObject({ reviews: 2, costUsd: 0.25, pricedReviews: 1 });
        expect(usage.judges.find(j => j.reviewer === 'codex')).toMatchObject({ reviews: 1, costUsd: null, model: null });
        expect(reviewerUsage(undefined, [], ConfigSchema.parse({}), now, threads).runs).toBe(3);
    });

    it('puts a thread review on the same local day as the spend log, so an evening review is counted once', () => {
        const saved = process.env.TZ;
        process.env.TZ = 'America/Los_Angeles';
        try {
            const store = temp();
            fs.mkdirSync(path.join(store, 'spend'));
            // Three reviews on the evening of Oct 7 in Los Angeles: Oct 8 in UTC. The spend log names the local day.
            fs.writeFileSync(path.join(store, 'spend', '2026-10-07.jsonl'), '{"runs":1,"usd":0.4}\n{"runs":1,"usd":0.4}\n{"runs":1,"usd":0.4}\n');
            const review = (at: string) => ({ at, task: 'branch:feat/x', branch: 'feat/x', kind: 'review', judges: ['claude'], cost_usd: 0.4 }) as never;
            const threads = [review('2026-10-08T02:00:00Z'), review('2026-10-08T03:00:00Z'), review('2026-10-08T04:00:00Z')];
            const usage = reviewerUsage(store, [], ConfigSchema.parse({}), now, threads);
            expect(usage.runs).toBe(3);
            expect(usage.days).toHaveLength(1);
            expect(usage.days[0]).toMatchObject({ day: '2026-10-07', runs: 3 });
            expect(usage.days[0].usd).toBeCloseTo(1.2);
        } finally {
            if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved;
        }
    });

    it('does not count a review that could not run (no judges, no cost) as a reviewer run', () => {
        const threads = [{ at: '2026-10-08T10:00:00Z', task: 'branch:feat/x', branch: 'feat/x', kind: 'review', outcome: 'unavailable' } as never];
        expect(reviewerUsage(undefined, [], ConfigSchema.parse({}), now, threads)).toMatchObject({ runs: 0, days: [], judges: [] });
    });

    it('leaves out records last written before the window without reading them', () => {
        const store = temp();
        const old = path.join(store, 'abc.f2.record.json');
        fs.writeFileSync(old, JSON.stringify({ at: '2026-10-08T00:00:00Z', judges: [{ reviewer: 'claude' }] }));
        fs.utimesSync(old, new Date('2026-08-01T00:00:00Z'), new Date('2026-08-01T00:00:00Z'));
        fs.writeFileSync(path.join(store, 'abc.f3.record.json'), JSON.stringify({ at: '2026-10-08T00:00:00Z', judges: 'not a list' }));
        expect(reviewerUsage(store, [], ConfigSchema.parse({}), now).judges).toEqual([]);
    });

    it("names who shared, dropped or replaced a team lesson: the team database's stamp first, the deciding machine's record else", () => {
        const lesson = (over: Record<string, unknown>) => ({ id: 'l', repositoryId: 'r', visibility: 'team', kind: 'memory', subject: 'retries: x', evidence: {}, confidence: 1, source: 'published:c', createdAt: 0, updatedAt: Date.parse('2026-10-06T00:00:00Z'), ...over }) as never;
        const decisions = buildDecisions({ lessons: [], dismissals: [], reviewDismissals: [], compiled: [], events: [], teamLessons: [
            lesson({ state: 'promoted', decidedBy: 'reviewer-s', evidence: { publishedBy: 'someone-else' } }),
            lesson({ state: 'rejected', evidence: { takenBackBy: 'owner-o' } }),
            lesson({ state: 'superseded', source: 'rigour_remember' }),
            lesson({ state: 'promoted', source: 'rigour_remember' }),
        ] });
        expect(decisions.map(d => [d.kind, d.who, d.source])).toEqual([['Team lesson shared', 'reviewer-s', 'team lessons'], ['Team lesson dropped', 'owner-o', 'team lessons']]);
    });

    it('does not count a command that timed out unanswered as a decision by a person', () => {
        const decisions = buildDecisions({ lessons: [], dismissals: [], reviewDismissals: [], compiled: [], events: [
            { type: 'x', tool: 'human_arbitration', requestId: 'r2', decision: 'timeout-deny', timestamp: '2026-10-06T00:01:00Z' } as never,
        ] });
        expect(decisions.map(d => [d.kind, byPerson(d)])).toEqual([['Command denied: nobody answered', false]]);
    });

    it('reports team sync off without a team, and the sharing state from the last sync', () => {
        expect(teamState(null, undefined)).toEqual({ sync: false, organization: null, team: null, actor: null, sharing: null, received: 0, candidates: null });
        expect(teamState({ organizationId: 'acme', teamId: 'web', actorId: 'dev' }, { version: 1, sharing: { shares: false, reason: 'a member' }, decisions: [], mine: {} }))
            .toMatchObject({ sync: true, organization: 'acme', sharing: { shares: false, reason: 'a member' }, candidates: null });
    });

    it("says what a person sees of teammates' candidates, and what an owner runs where the database lacks candidate review", () => {
        const scope = { organizationId: 'acme', teamId: 'web', actorId: 'dev' };
        expect(teamState(scope, undefined, { role: 'sme', candidateReview: true }).candidates).toContain("you see every member's team candidates");
        expect(teamState(scope, undefined, { role: 'member', candidateReview: true }).candidates).toBeNull();
        expect(teamState(scope, undefined, undefined, { count: 1, latest: 'refused by the team database: policy' }).refused).toEqual({ count: 1, latest: 'refused by the team database: policy' });
        expect(teamState(scope, undefined, undefined, { count: 0 })).not.toHaveProperty('refused');
        expect(teamState(scope, undefined, { role: 'sme', candidateReview: false, olderRules: true }).candidates).toContain('never run an older init-schema');
        for (const access of [{ role: 'owner' as const, candidateReview: false }, { role: 'member' as const, candidateReview: false }]) {
            const missing = teamState(scope, undefined, access).candidates;
            expect(missing).toContain("Teammates' candidates are visible only to them until shared.");
            expect(missing).toContain("the database refuses a member's team memories");
            expect(missing).toContain('rigour team init-schema --database-url <administrator url>');
        }
    });
});

describe('loadGovernance', () => {
    it('reads a repository: its agents, threads, decisions and settings', async () => {
        const repo = temp();
        spawnSync('git', ['init', '-q', '-b', 'main', repo]);
        fs.mkdirSync(path.join(repo, '.claude'));
        fs.writeFileSync(path.join(repo, '.claude', 'settings.json'), '{"hooks":{"PostToolUse":[{"command":"rigour hooks check"}]}}');
        fs.mkdirSync(path.join(repo, '.rigour'));
        fs.writeFileSync(path.join(repo, '.rigour', 'dismissed.json'), JSON.stringify({ entries: [{ key: 'k', reason: 'fine here', at: '2026-10-08T00:00:00Z' }] }));
        fs.writeFileSync(path.join(repo, 'rigour.yml'), 'gates:\n  max_file_lines: 300\n');
        const threads = path.join(repo, '.git', 'rigour', 'threads');
        fs.mkdirSync(threads, { recursive: true });
        fs.writeFileSync(path.join(threads, 'main-1.jsonl'), `${JSON.stringify(thread('edit-check', '2026-10-08T00:00:00Z', { agent: 'claude' }))}\nnot json\n`);
        const gov = await loadGovernance(repo, undefined, now, { teamConfig: async () => null, teamCache: () => undefined });
        expect(gov.coverage.rows.map(r => r.agent)).toEqual(['Claude Code']);
        expect(gov.coverage.rows[0].cells.edit).toEqual({ configured: 'on', seen: '2026-10-08T00:00:00Z' });
        expect(gov.decisions).toEqual([expect.objectContaining({ kind: 'Not a bug', who: null, reason: 'fine here' })]);
        expect(gov.decisionsRecent).toBe(1);
        expect(gov.qualityGates).toMatchObject({ configFile: 'rigour.yml', rules: expect.arrayContaining([expect.objectContaining({ name: 'File length', setting: '300 lines' })]) });
        expect(gov.reviewer.runs).toBe(0);
        expect(gov.team.sync).toBe(false);
        expect(gov.fixes.map(f => f.name)).toContain('Stops an agent finishing with a known bug');
    });
});
