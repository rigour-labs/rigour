import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadPull, loadPulls } from './studio-pulls.js';

let repo: string;
let home: string;
const savedHome = process.env.RIGOUR_HOME;
const HEAD1 = 'a'.repeat(40);
const HEAD2 = 'b'.repeat(40);
const now = Date.parse('2026-10-16T12:00:00Z');

/** The thread file name thread.ts gives a branch: readThread finds a branch by it. */
const branchFile = (branch: string) => `${branch.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80)}-${createHash('sha1').update(branch).digest('hex').slice(0, 8)}.jsonl`;

function writeThread(branch: string, events: Array<Record<string, unknown>>): void {
    const dir = path.join(repo, '.git', 'rigour', 'threads');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, branchFile(branch)), events.map(e => JSON.stringify({ task: `branch:${branch}`, branch, ...e })).join('\n') + '\nnot json\n');
}

function writeRecord(head: string, integrity: string, extra: { blocking: string[]; judges: unknown[]; brokenRule?: string }): void {
    const dir = path.join(repo, '.git', 'rigour-reviewer');
    fs.mkdirSync(dir, { recursive: true });
    const record = {
        version: 1, head, base: 'c'.repeat(40), scope: 'full', at: '2026-10-10T10:00:00Z', judges: extra.judges,
        verified: { blocking: extra.blocking.map(id => ({ id, kind: 'finding', class: 'bug', issue: 'x' })), should_fix: [], rules: { served: 4, followed: 2, broken: extra.brokenRule ? 1 : 0, not_applicable: 1 }, lessons: { served: 2, applied: 1 }, prior_points: { open: 0, resolved: 0, answer_in_reply: 0 }, unverified: 0, notes: 0, disputed: 1 },
        reported: { human_reviews: 2 }, people: { dismissed: 0 }, integrity,
    };
    fs.writeFileSync(path.join(dir, `${head}.12345678.record.json`), JSON.stringify(record));
    fs.writeFileSync(path.join(dir, `${head}.12345678.json`), JSON.stringify({ rules: extra.brokenRule ? [{ id: 'r1', status: 'broken', rule: extra.brokenRule }, { id: 'r2', status: 'followed', rule: 'Other' }] : [] }));
}

beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'rigour-home-pulls-'));
    process.env.RIGOUR_HOME = home;
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-pulls-'));
    execFileSync('git', ['-C', repo, 'init', '-q', '-b', 'main']);
    execFileSync('git', ['-C', repo, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init']);
    fs.mkdirSync(path.join(repo, '.rigour'));
});
afterEach(() => {
    process.env.RIGOUR_HOME = savedHome;
    for (const dir of [repo, home]) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function seedMergedPr(): void {
    writeThread('feat/checkout', [
        { at: '2026-10-10T08:00:00Z', kind: 'brief', agent: 'claude', items: 3 },
        { at: '2026-10-10T08:01:00Z', kind: 'brief', agent: 'cli', items: 0 },
        { at: '2026-10-10T08:05:00Z', kind: 'edit-check', files: ['src/pay.ts'], findings: 2 },
        { at: '2026-10-10T08:07:00Z', kind: 'edit-check', files: ['src/pay.ts'], findings: 0, agent: 'cursor' },
        { at: '2026-10-10T08:30:00Z', kind: 'stop-review', agent: 'claude', blocked: true, blocking: 1 },
        { at: '2026-10-10T09:00:00Z', kind: 'push', passed: false, failed: 1 },
        { at: '2026-10-10T10:00:00Z', kind: 'review', head: HEAD1, outcome: 'findings', blocking: 2, should_fix: 1, pr: 42, pr_title: 'Retry the charge once', lessons_applied: ['L1'], integrity: 'i1', judges: ['claude'], cost_usd: 0.5, cost_basis: 'runs' },
        { at: '2026-10-11T10:00:00Z', kind: 'review', head: HEAD2, outcome: 'passed', blocking: 0, should_fix: 0, pr: 42, judges: ['codex'], cost_usd: 0.25, cost_basis: 'runs' },
    ]);
    writeRecord(HEAD1, 'i1', { blocking: ['b1', 'b2'], judges: [{ reviewer: 'claude', model: 'opus', cost_usd: 0.48 }], brokenRule: 'Money is integer cents' });
    fs.writeFileSync(path.join(repo, '.rigour', 'outcomes.json'), JSON.stringify({ version: 1, outcomes: { m1: {
        pr: 42, mergeSha: 'd'.repeat(40), mergedAt: '2026-10-12T08:00:00Z', branch: 'feat/checkout', author: 'dev@example.com', files: ['src/pay.ts'], ci: 'success',
        followUps: [{ sha: 'e'.repeat(40), at: '2026-10-13T08:00:00Z', subject: 'fix: round the refund', files: ['src/pay.ts'], fix: true }],
        windowEnd: '2026-10-19T08:00:00Z', settled: false, checkedAt: '2026-10-13T09:00:00Z',
    } } }));
    fs.writeFileSync(path.join(repo, '.rigour', 'review-lessons.json'), JSON.stringify({ lessons: [
        { id: 'L1', text: 'Charge retries carry an idempotency key', file: 'src/pay.ts', symbols: [], state: 'verified', evidence: [{ kind: 'point', pr: 42, comment: 'Needs an idempotency key', author: 'lead@example.com', source: 'person' }], createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' },
        { id: 'L2', text: 'Unrelated', file: 'src/a.ts', symbols: [], state: 'candidate', evidence: [{ kind: 'point', pr: 7, comment: 'x', author: 'x@example.com' }], createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' },
    ] }));
}

describe('the Pull requests page', () => {
    it('lists a pull request with its rounds, merge and follow-ups, and a branch reviewed before its pull request', () => {
        seedMergedPr();
        writeThread('spike/cache', [{ at: '2026-10-14T10:00:00Z', kind: 'review', head: 'f'.repeat(40), outcome: 'passed', blocking: 0, should_fix: 2, judges: ['claude'] }]);
        writeThread('chore/edits-only', [{ at: '2026-10-15T10:00:00Z', kind: 'edit-check', files: ['a.ts'], findings: 0 }]);
        const list = loadPulls(repo, undefined, now);
        expect(list.rows.map(r => r.key)).toEqual(['branch:spike/cache', '#42']);
        expect(list.rows[1]).toMatchObject({
            pr: 42, title: 'Retry the charge once', state: 'merged', rounds: 2, lessonsApplied: 1, blockingFound: 2, ci: 'success',
            followUps: { commits: 1, fixes: 1 }, lastReview: { outcome: 'passed', blocking: 0 }, lastActivity: '2026-10-12T08:00:00Z',
        });
        expect(list.rows[0]).toMatchObject({ pr: null, state: 'not-opened', ci: null, followUps: null });
        expect(list.window).toEqual({ days: 28, reviewed: 1, blocking: 2, lessonsApplied: 1, merged: 1, mergedClean: 1 });
        expect(list.mergesRecorded).toBe(true);
    });

    it('says merges are unknown, not zero, when none is recorded', () => {
        writeThread('feat/x', [{ at: '2026-10-14T10:00:00Z', kind: 'review', outcome: 'passed', blocking: 0, should_fix: 0, pr: 5 }]);
        const list = loadPulls(repo, undefined, now);
        expect(list.rows[0]).toMatchObject({ state: 'no-merge', ci: null, followUps: null, blockingFound: 0 });
        expect(list.mergesRecorded).toBe(false);
        expect(loadPulls(fs.mkdtempSync(path.join(os.tmpdir(), 'no-git-')), undefined, now)).toMatchObject({ rows: [], threadsRecorded: false });
    });

    it('walks one pull request from the brief to the merge, with the record behind each round', () => {
        seedMergedPr();
        const d = loadPull(repo, new URL('http://studio/api/pull?n=42'));
        if (!d.found) throw new Error('not found');
        expect(d.steps.brief).toMatchObject({ count: 2, items: 3, agents: ['claude'] });
        expect(d.steps.edits).toMatchObject({ checks: 2, findings: 2, files: 1, flagged: 1, cleaned: 1, agents: ['cursor'] });
        expect(d.steps.stop).toMatchObject({ count: 1, blocked: 1, clean: 0 });
        expect(d.steps.push).toMatchObject({ count: 1, passed: 0, failed: 1 });
        const [first, second] = d.steps.reviews;
        expect(first).toMatchObject({ recorded: true, judges: [{ reviewer: 'claude', model: 'opus' }], rules: { served: 4, broken: 1, brokenNames: ['Money is integer cents'] }, disputed: 1, humanReviews: 2, cost: [{ usd: 0.48, by: 'claude', basis: 'judge' }] });
        expect(first.lessons.applied).toEqual([{ id: 'L1', text: 'Charge retries carry an idempotency key' }]);
        // No record on this machine for the second round: the event's own figures, and nothing invented.
        expect(second).toMatchObject({ recorded: false, rules: null, disputed: null, humanReviews: null, judges: [{ reviewer: 'codex', model: null }], cost: [{ usd: 0.25, by: 'codex', basis: 'all runs' }] });
        expect(d.steps.human).toEqual({ reviews: 2, points: [expect.objectContaining({ lesson: 'Charge retries carry an idempotency key', author: 'lead@example.com', source: 'person' })] });
        expect(d.steps.merge).toMatchObject({ ci: 'success', fixes: 1, author: 'dev@example.com', source: 'outcomes', reverted: null });
        expect(d.facts).toMatchObject({ caughtBeforeReview: { findings: 2, stops: 1, pushes: 1 }, rounds: 2, durationMs: 2 * 24 * 60 * 60 * 1000 });
        expect(d.facts.cost).toEqual([{ usd: 0.48, by: 'claude', basis: 'judge' }, { usd: 0.25, by: 'codex', basis: 'all runs' }]);
    });

    it('reads a merge from the thread when outcomes.json is not in this checkout, and opens a branch by name', () => {
        writeThread('feat/y', [
            { at: '2026-10-14T10:00:00Z', kind: 'review', outcome: 'passed', blocking: 0, should_fix: 0, pr: 9 },
            { at: '2026-10-15T10:00:00Z', kind: 'merge', pr: 9, merge_sha: 'abc', merged_at: '2026-10-15T09:00:00Z' },
            { at: '2026-10-16T10:00:00Z', kind: 'outcome', pr: 9, ci: 'failure', follow_ups: 2, fixes: 1, reverted: true },
        ]);
        const d = loadPull(repo, new URL('http://studio/api/pull?branch=feat/y'));
        if (!d.found) throw new Error('not found');
        expect(d).toMatchObject({ key: '#9', pr: 9, state: 'reverted' });
        const byPr = loadPull(repo, new URL('http://studio/api/pull?n=9'));
        expect(byPr).toMatchObject({ state: 'reverted', steps: { merge: { ci: 'failure', followUpCount: 2, fixes: 1, followUps: null, source: 'thread' } } });
        expect(loadPull(repo, new URL('http://studio/api/pull?n=404'))).toEqual({ found: false, key: '#404' });
    });

    it('keeps a reused branch\'s two pull requests apart', () => {
        writeThread('feat/reuse', [
            { at: '2026-10-10T10:00:00Z', kind: 'review', outcome: 'findings', blocking: 1, should_fix: 0, pr: 1 },
            { at: '2026-10-11T10:00:00Z', kind: 'merge', pr: 1, merge_sha: 'abc', merged_at: '2026-10-11T09:00:00Z' },
            { at: '2026-10-12T10:00:00Z', kind: 'review', outcome: 'passed', blocking: 0, should_fix: 0, pr: 2 },
            { at: '2026-10-13T10:00:00Z', kind: 'review', outcome: 'passed', blocking: 0, should_fix: 0, pr: 2 },
        ]);
        const list = loadPulls(repo, undefined, now);
        expect(list.rows.map(r => [r.key, r.rounds, r.state, r.blockingFound])).toEqual([['#2', 2, 'no-merge', 0], ['#1', 1, 'merged', 1]]);
        const one = loadPull(repo, new URL('http://studio/api/pull?n=1'));
        if (!one.found) throw new Error('not found');
        expect([one.facts.rounds, one.state]).toEqual([1, 'merged']);
        const two = loadPull(repo, new URL('http://studio/api/pull?n=2'));
        if (!two.found) throw new Error('not found');
        expect([two.facts.rounds, two.state, two.steps.merge]).toEqual([2, 'no-merge', null]);
    });

    it('reads a damaged record as not found instead of failing the page', () => {
        writeThread('feat/bad', [{ at: '2026-10-14T10:00:00Z', kind: 'review', head: HEAD1, outcome: 'findings', blocking: 3, should_fix: 0, pr: 7, judges: ['claude'] }]);
        const dir = path.join(repo, '.git', 'rigour-reviewer');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, `${HEAD1}.1.record.json`), JSON.stringify({ at: 5, verified: { rules: { served: 'x' }, blocking: [{ id: 'b1' }, 'junk'] }, judges: 'x', reported: null }));
        expect(loadPulls(repo, undefined, now).rows[0]).toMatchObject({ pr: 7, blockingFound: 1 });
        const d = loadPull(repo, new URL('http://studio/api/pull?n=7'));
        if (!d.found) throw new Error('not found');
        expect(d.steps.reviews[0]).toMatchObject({ recorded: true, judges: [], rules: { served: 0, broken: 0 }, humanReviews: null, disputed: null, cost: [] });
        // Without its blocking list the record is not used: the event's own figures stand.
        fs.writeFileSync(path.join(dir, `${HEAD1}.1.record.json`), JSON.stringify({ verified: { rules: {}, blocking: 'x' } }));
        expect(loadPulls(repo, undefined, now).rows[0]).toMatchObject({ pr: 7, blockingFound: 3 });
        const again = loadPull(repo, new URL('http://studio/api/pull?n=7'));
        if (!again.found) throw new Error('not found');
        expect(again.steps.reviews[0]).toMatchObject({ recorded: false, rules: null, judges: [{ reviewer: 'claude', model: null }] });
    });

    it('opens a branch named like a number as that branch, never as a pull request', () => {
        writeThread('42', [{ at: '2026-10-14T10:00:00Z', kind: 'review', outcome: 'passed', blocking: 0, should_fix: 0 }]);
        writeThread('feat/other', [{ at: '2026-10-14T10:00:00Z', kind: 'review', outcome: 'passed', blocking: 0, should_fix: 0, pr: 42 }]);
        expect(loadPull(repo, new URL('http://studio/api/pull?branch=42'))).toMatchObject({ found: true, key: 'branch:42', pr: null, branches: ['42'] });
    });

    it('lists only branches with activity in the last 90 days, and says how many it left out', () => {
        writeThread('feat/old', [{ at: '2026-01-14T10:00:00Z', kind: 'review', outcome: 'passed', blocking: 0, should_fix: 0, pr: 3 }]);
        const old = path.join(repo, '.git', 'rigour', 'threads', branchFile('feat/old'));
        fs.utimesSync(old, new Date('2026-01-14T10:00:00Z'), new Date('2026-01-14T10:00:00Z'));
        const list = loadPulls(repo, undefined, now);
        expect([list.rows, list.scope, list.threadsRecorded]).toEqual([[], { days: 90, older: 1 }, true]);
    });
});
