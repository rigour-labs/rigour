import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadDevelopment } from './studio-development.js';
import { fromEvents, joinRecords, readThreadRecords, type DevRecord } from './studio-development-parts.js';

const now = new Date('2026-10-09T12:00:00Z');
const at = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * 60_000).toISOString();
const DAY = 24 * 60;

let repo: string;
const jsonl = (file: string, lines: object[]) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
};

beforeEach(() => {
    repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'development-')));
    execFileSync('git', ['init', '-q', repo]);
    fs.mkdirSync(path.join(repo, '.rigour'));
});
afterEach(() => fs.rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

/** One agent session on feat/pay: briefed, two edits (one with a finding), sent back once at the stop, then a push. */
function writeFixtures(): void {
    const thread = (minutesAgo: number, kind: string, fields: object) => ({ at: at(minutesAgo), task: 'branch:feat/pay', branch: 'feat/pay', kind, ...fields });
    jsonl(path.join(repo, '.git', 'rigour', 'threads', 'feat_pay-1234abcd.jsonl'), [
        thread(40 * DAY, 'edit-check', { session: 's0', files: ['src/old.ts'], findings: 0 }),
        thread(60, 'brief', { agent: 'claude', session: 's1', items: 3, files: ['src/pay.ts'] }),
        thread(50, 'edit-check', { session: 's1', files: ['src/pay.ts'], findings: 1, status: 'fail' }),
        thread(45, 'edit-check', { session: 's1', files: ['src/pay.ts'], findings: 0, status: 'pass' }),
        thread(30, 'stop-review', { agent: 'claude', session: 's1', blocked: true, blocking: 1, files: ['src/pay.ts'] }),
        thread(20, 'push', { passed: true, failed: 0 }),
        thread(10, 'review', { outcome: 'pass' }),
    ]);
    const event = (minutesAgo: number, type: string, fields: object) => ({ type, timestamp: new Date(Date.parse(at(minutesAgo)) + 800).toISOString(), ...fields });
    jsonl(path.join(repo, '.rigour', 'events.jsonl'), [
        event(60, 'lessons_served', { via: 'brief', lessons: ['Amounts are cents', 'Keys come from env', 'Retry once'], rules: 1, files: ['src/pay.ts'] }),
        event(50, 'hook_check', { blocked: true, files: ['src/pay.ts'], findings: [{ gate: 'security-patterns', file: 'src/pay.ts', message: 'Stripe key in code' }] }),
        event(45, 'hook_check', { blocked: false, files: ['src/pay.ts'], findings: [] }),
        event(30, 'stop_review', { tool: 'claude', session: 's1', blocked: true, blocking: 1, findings: [{ rule: 'missing-test', title: 'No test', file: 'src/pay.ts' }] }),
        // Not in any thread (a detached head): counted from the event alone, agent named by RIGOUR_AGENT_ID.
        event(5, 'hook_check', { agentId: 'codex', blocked: false, files: ['src/cart.ts'], findings: [{ gate: 'any', file: 'src/cart.ts', message: 'Untyped any' }] }),
        event(4, 'lessons_served', { via: 'recall', lessons: ['Amounts are cents', 'Use the queue'] }),
    ]);
    jsonl(path.join(repo, '.rigour', 'stories.jsonl'), [
        { id: 'a', at: at(48), openedAt: at(50), stage: 'edit', file: 'src/pay.ts', rule: 'security-patterns', title: 'Stripe key in code', diff: ['-k', '+env'] },
        { id: 'b', at: at(25), openedAt: at(30), stage: 'stop', file: 'src/pay.ts', rule: 'missing-test', title: 'No test', diff: [] },
        { id: 'c', at: at(30 * DAY), openedAt: at(30 * DAY + 5), stage: 'edit', file: 'src/old.ts', rule: 'any', title: 'Old', diff: [] },
    ]);
    fs.mkdirSync(path.join(repo, '.rigour', 'agent-fixes'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.rigour', 'agent-fixes', 'open.json'), JSON.stringify({
        k: { file: 'src/cart.ts', rule: 'any', title: 'Untyped any', before: '', openedAt: at(5), stage: 'edit' },
    }));
}

describe('loadDevelopment', () => {
    it('counts each check once, from the thread, with what its event line said', () => {
        writeFixtures();
        const dev = loadDevelopment(repo, new URL('http://x/api/development'), now);
        expect(dev.window.days).toBe(7);
        expect(dev.stages).toEqual({
            brief: { briefings: 1, sessions: 1, told: 3, onRequest: 2 },
            edits: { checked: 3, withFindings: 2, blocked: 1 },
            stop: { reviews: 1, blocked: 1, nothingToReview: 0, fixedBeforeDone: 1 },
            push: { runs: 1, passed: 1, failed: 0 },
        });
        expect(dev.caught).toEqual({ total: 3, fixedByAgent: 2, stillOpen: 1, medianMinutesToFix: 4, byStage: { edit: 2, review: 0, stop: 1, pr: 0 } });
        expect(dev.recordingSince).toBe(at(40 * DAY));
        expect(dev.topRules[0]).toEqual({ rule: 'security-patterns', title: 'Stripe key in code', caught: 1, fixed: 1 });
        expect(dev.recentFixes.map(s => s.id)).toEqual(['b', 'a']);
        expect(dev.open).toEqual([expect.objectContaining({ file: 'src/cart.ts', title: 'Untyped any' })]);
    });

    it('names agents only where a hook recorded one, and puts every push under "not recorded"', () => {
        writeFixtures();
        const rows = loadDevelopment(repo, undefined, now).byAgent;
        expect(rows).toEqual([
            { agent: 'claude', briefings: 1, editsChecked: 0, editsWithFindings: 0, stopReviews: 1, sentBack: 1, pushes: null },
            { agent: 'codex', briefings: 0, editsChecked: 1, editsWithFindings: 1, stopReviews: 0, sentBack: 0, pushes: null },
            { agent: null, briefings: 0, editsChecked: 2, editsWithFindings: 1, stopReviews: 0, sentBack: 0, pushes: 1 },
        ]);
    });

    it('lists what mattered, newest first, with the branch from the thread and the detail from the event', () => {
        writeFixtures();
        const feed = loadDevelopment(repo, undefined, now).feed;
        expect(feed.map(f => f.text)).toEqual([
            'Reported 1 problem on an edit to src/cart.ts',
            'Push checks passed',
            'Fixed by the agent: No test',
            'Agent said done; sent back to fix 1 problem',
            'Fixed by the agent: Stripe key in code',
            'Blocked an edit to src/pay.ts: 1 problem',
            'Briefed before writing: 1 rule and 2 lessons for src/pay.ts',
        ]);
        expect(feed[3]).toMatchObject({ branch: 'feat/pay', agent: 'claude', detail: 'src/pay.ts: No test' });
        expect(feed[2].detail).toBe('src/pay.ts · 5 minutes after Rigour reported it');
        expect(feed[0]).toMatchObject({ branch: null, agent: 'codex' });
    });

    it('reaches back four weeks on request', () => {
        writeFixtures();
        const dev = loadDevelopment(repo, new URL('http://x/api/development?days=28'), now);
        expect(dev.window.days).toBe(28);
        expect(dev.caught.fixedByAgent).toBe(2); // the 30-day-old fix is still outside
        expect(loadDevelopment(repo, new URL('http://x/api/development?days=9'), now).window.days).toBe(7);
    });

    it('says not recorded, not zero, when no event line recorded a block', () => {
        jsonl(path.join(repo, '.git', 'rigour', 'threads', 'main-00000000.jsonl'), [
            { at: at(10), task: 'branch:main', branch: 'main', kind: 'edit-check', files: ['a.ts'], findings: 1 },
            { at: at(9), task: 'branch:main', branch: 'main', kind: 'stop-review', agent: 'cursor', blocked: false, blocking: 0 },
            { at: at(8), task: 'branch:main', branch: 'main', kind: 'brief', items: 0, files: ['a.ts'] },
        ]);
        const dev = loadDevelopment(repo, undefined, now);
        expect(dev.stages.edits).toEqual({ checked: 1, withFindings: 1, blocked: null });
        expect(dev.stages.stop.nothingToReview).toBeNull();
        expect(dev.stages.brief.sessions).toBeNull();
        // A clean edit check and a briefing with nothing to tell are counted, not listed.
        expect(dev.feed.map(f => f.text)).toEqual(['Agent said done; nothing blocking', 'Reported 1 problem on an edit to a.ts']);
        expect(dev.caught.medianMinutesToFix).toBeNull();
    });

    it('does not name an agent where the brief recorded the way it was asked for (cli, mcp)', () => {
        jsonl(path.join(repo, '.git', 'rigour', 'threads', 'main-00000000.jsonl'), [
            { at: at(10), task: 'branch:main', branch: 'main', kind: 'brief', agent: 'cli', items: 2, files: ['a.ts'] },
            { at: at(9), task: 'branch:main', branch: 'main', kind: 'brief', agent: 'mcp', items: 1, files: ['a.ts'] },
        ]);
        const dev = loadDevelopment(repo, undefined, now);
        expect(dev.byAgent.map(r => [r.agent, r.briefings])).toEqual([[null, 2]]);
        expect(dev.feed.map(f => f.agent)).toEqual([null, null]);
    });

    it('is empty, with nothing recorded, in a repository Rigour has not seen work in', () => {
        const dev = loadDevelopment(repo, undefined, now);
        expect([dev.recordingSince, dev.feed, dev.byAgent, dev.caught.total]).toEqual([null, [], [], 0]);
    });
});

describe('joinRecords', () => {
    const record = (stage: DevRecord['stage'], when: string, fields: Partial<DevRecord> = {}): DevRecord =>
        ({ at: when, stage, branch: 'b', agent: null, session: null, files: ['a.ts'], count: 0, held: null, said: [], ...fields });

    it('joins an event only to a thread line of the same check written at the same moment', () => {
        const threads = [record('edit', '2026-10-09T10:00:00.000Z'), record('edit', '2026-10-09T10:00:01.000Z', { files: ['b.ts'] })];
        const events = [
            record('edit', '2026-10-09T10:00:01.200Z', { branch: null, files: ['b.ts'], held: true, said: ['B'] }),
            record('edit', '2026-10-09T10:00:00.100Z', { branch: null, held: false, said: ['A'] }),
            record('edit', '2026-10-09T10:09:00.000Z', { branch: null, said: ['later'] }),
        ];
        const joined = joinRecords(threads, events);
        expect(joined.map(r => [r.branch, r.said[0], r.held])).toEqual([['b', 'A', false], ['b', 'B', true], [null, 'later', null]]);
    });

    it('never joins a stop review from another agent session', () => {
        const joined = joinRecords([record('stop', '2026-10-09T10:00:00Z', { session: 's1' })], [record('stop', '2026-10-09T10:00:00Z', { session: 's2', branch: null })]);
        expect(joined).toHaveLength(2);
    });

    it('reads only thread files written to within the window', () => {
        const dir = path.join(repo, 'threads');
        jsonl(path.join(dir, 'old.jsonl'), [{ at: at(10), task: 't', branch: 'old', kind: 'push', passed: true }]);
        fs.utimesSync(path.join(dir, 'old.jsonl'), new Date(now.getTime() - 9 * DAY * 60_000), new Date(now.getTime() - 9 * DAY * 60_000));
        jsonl(path.join(dir, 'new.jsonl'), [{ at: at(10), task: 't', branch: 'new', kind: 'push', passed: false, failed: 2 }]);
        const since = now.getTime() - 7 * DAY * 60_000;
        expect(readThreadRecords(dir, since).map(r => [r.branch, r.held, r.count])).toEqual([['new', true, 2]]);
    });

    it('treats events of other kinds and other channels as not part of the loop', () => {
        const since = Date.parse('2026-10-01T00:00:00Z');
        expect(fromEvents([{ type: 'tool_call', timestamp: '2026-10-09T00:00:00Z' }, { type: 'lessons_served', via: 'recall', timestamp: '2026-10-09T00:00:00Z', lessons: ['x'] }], since)).toEqual([]);
    });
});

describe('time to fix', () => {
    it('is the median over fixes that recorded when they were reported', () => {
        const story = (id: string, minutes: number | null) => ({ id, at: at(1), ...(minutes === null ? {} : { openedAt: at(1 + minutes) }), stage: 'edit', file: 'a.ts', rule: 'r', title: 't', diff: [] });
        jsonl(path.join(repo, '.rigour', 'stories.jsonl'), [story('a', 2), story('b', 10), story('c', null), story('d', 30)]);
        const dev = loadDevelopment(repo, undefined, now);
        expect(dev.caught.medianMinutesToFix).toBe(10);
        expect(dev.topRules).toEqual([{ rule: 'r', title: 't', caught: 4, fixed: 4 }]);
    });
});
