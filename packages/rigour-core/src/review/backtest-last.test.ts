import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigSchema } from '../types/index.js';
import type { Exec } from './reviewer/exec.js';
import type { Ledger, RoundResult } from './backtest.js';
import { backtestLast, formatLast, scoreLast, LAST_LEDGER_PATH } from './backtest-last.js';
import { roundsForPr } from './backtest-init.js';

const config = ConfigSchema.parse({ version: 1 });
const item = (file: string, line: number, blocking = true, gate = 'reviewer:claude') => ({ gate, file, line, text: `${file} scan has no upper bound`, blocking });
const result = (round: string, items: ReturnType<typeof item>[], caught = 0, costUsd?: number): RoundResult => ({ round, head: 'h', base: 'b', points: Array.from({ length: caught }, (_, i) => ({ id: `p${i}`, point: 'p', caught: true, noted: false })), falseBlocks: [], items, durationMs: 1000, ...(costUsd !== undefined ? { costUsd } : {}) });

describe('the front door report', () => {
    const ledger: Ledger = { rounds: [
        { id: 'pr7-r1', commit: 'c', base: 'b', reviewed_at: '2026-04-12T12:00:00Z', pr: 7, points: [{ id: 'R1-1', point: 'drops the currency', file: 'src/b\\.ts', lines: [1, 11] }], must_not_flag: [] },
        { id: 'pr7-r2', commit: 'c', base: 'b', reviewed_at: '2026-04-12T13:00:00Z', pr: 7, points: [{ id: 'R2-1', point: 'the export reads every line item', file: 'src/a\\.ts', lines: [1, 11] }], must_not_flag: [] },
        { id: 'pr7-r3', commit: 'c', base: 'b', reviewed_at: '2026-04-12T14:00:00Z', pr: 7, points: [{ id: 'R3-1', point: 'still unbounded', file: 'src/a\\.ts', lines: [1, 11] }], must_not_flag: [] },
        { id: 'pr7-approved', commit: 'c', base: 'b', reviewed_at: '2026-04-12T15:00:00Z', pr: 7, points: [], must_not_flag: [] },
        { id: 'pr8-approved', commit: 'c', base: 'b', reviewed_at: '2026-04-13T15:00:00Z', pr: 8, points: [], must_not_flag: [] },
    ] };

    it('counts points raised later that an earlier round blocked, with how many rounds earlier, and every block on an approved head', () => {
        const results = [result('pr7-r1', [item('src/a.ts', 3)]), result('pr7-r2', [item('src/a.ts', 3)], 1, 1.5), result('pr7-r3', [], 0, 0.5), result('pr7-approved', [item('src/a.ts', 3)]), result('pr8-approved', [item('src/z.ts', 9, false)])];
        const r = scoreLast(ledger, results);
        expect(r).toMatchObject({ prs: 2, rounds: 5, approvedHeads: 2, pointsLater: 2, sameRound: 1, costUsd: 2 });
        expect(r.early).toEqual([
            { pr: 7, round: 'pr7-r1', point: 'the export reads every line item', by: 'reviewer:claude src/a.ts:3', roundsEarlier: 1 },
            { pr: 7, round: 'pr7-r1', point: 'still unbounded', by: 'reviewer:claude src/a.ts:3', roundsEarlier: 2 }, // the earliest round that blocked it counts
        ]);
        expect(r.blocksOnApproved).toEqual([{ pr: 7, round: 'pr7-approved', item: item('src/a.ts', 3) }]); // an advisory item on pr8 is not a block
        const text = formatLast({ ...r, skipped: ['pr9-r1: commit abcdef012 is not reachable (force-pushed away)'] });
        expect(text.split('\n')[0]).toBe('1 blocking item(s) on 2 approved head(s): every one is a block the team would have overridden.'); // the worse number first
        expect(text).toContain('2 of 2 point(s) people raised in a later round were already blocked, 1.5 round(s) earlier on average.');
        expect(text).toContain('skipped pr9-r1: commit abcdef012');
        const clean = formatLast({ ...scoreLast(ledger, results.map(x => (x.round.endsWith('-approved') ? { ...x, items: [] } : x))), skipped: [] });
        expect(clean.split('\n')[0]).toContain('point(s) people raised in a later round were already blocked'); // nothing on approved heads: the catches lead
        expect(clean).toContain('0 blocking items on 2 approved head(s).');
    });
});

describe('rigour backtest --last', () => {
    let repo: string;
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
    const commit = (message: string, date: string) => { git('add', '-A'); execFileSync('git', ['-C', repo, 'commit', '-qm', message], { env: { ...process.env, GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date } }); return git('rev-parse', 'HEAD'); };
    let reviewed: string;
    const fake = (calls: string[][]): Exec => async (command, args, options) => {
        calls.push([command, ...args]);
        if (command === 'git') {
            if (args[0] === 'fetch') return { exitCode: 0, stdout: '', stderr: '' }; // the head is already here
            try {
                return { exitCode: 0, stdout: execFileSync('git', args, { cwd: options.cwd, encoding: 'utf8', stdio: 'pipe' }), stderr: '' };
            } catch (error: any) {
                return { exitCode: error.status ?? 1, stdout: '', stderr: String(error.stderr ?? '') };
            }
        }
        if (args[0] === 'auth') return { exitCode: 0, stdout: 'token\n', stderr: '' };
        if (args[0] === 'pr' && args[1] === 'list') return { exitCode: 0, stdout: JSON.stringify([{ number: 7, mergedAt: '2026-04-12T16:00:00Z' }, { number: 6, mergedAt: '2026-04-11T16:00:00Z' }]), stderr: '' };
        if (args[0] === 'pr') return { exitCode: 0, stdout: 'author\n', stderr: '' };
        const pr = /pulls\/(\d+)\//.exec(args[1])?.[1];
        if (args[1].endsWith('/reviews')) {
            if (pr === '6') return { exitCode: 0, stdout: JSON.stringify([{ id: 60, user: { login: 'author', type: 'User' }, body: 'self note', state: 'COMMENTED', submitted_at: '2026-04-11T12:00:00Z', commit_id: reviewed }]), stderr: '' };
            return { exitCode: 0, stdout: JSON.stringify([
                { id: 1, user: { login: 'senior', type: 'User' }, body: 'first pass', state: 'CHANGES_REQUESTED', submitted_at: '2026-04-12T12:00:00Z', commit_id: reviewed },
                { id: 2, user: { login: 'senior', type: 'User' }, body: 'second pass', state: 'CHANGES_REQUESTED', submitted_at: '2026-04-12T13:00:00Z', commit_id: reviewed },
                { id: 3, user: { login: 'senior', type: 'User' }, body: '', state: 'APPROVED', submitted_at: '2026-04-12T14:00:00Z', commit_id: reviewed },
            ]), stderr: '' };
        }
        if (args[1].includes('/reviews/1/')) return { exitCode: 0, stdout: JSON.stringify([{ path: 'b.ts', line: 1, body: 'Drops the currency', created_at: '2026-04-12T12:00:00Z' }]), stderr: '' };
        if (args[1].includes('/reviews/2/')) return { exitCode: 0, stdout: JSON.stringify([{ path: 'a.ts', line: 1, body: 'The export reads every line item.', created_at: '2026-04-12T13:00:00Z' }]), stderr: '' };
        return { exitCode: 0, stdout: '[]', stderr: '' };
    };

    beforeEach(() => {
        repo = fs.mkdtempSync(path.join(os.tmpdir(), 'backtest-last-'));
        git('init', '-q', '-b', 'main');
        git('config', 'user.email', 't@example.com');
        git('config', 'user.name', 't');
        git('config', 'commit.gpgsign', 'false');
        fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 1;\n');
        commit('main', '2026-04-12T09:00:00Z');
        git('checkout', '-q', '-b', 'feature');
        fs.writeFileSync(path.join(repo, 'b.ts'), 'export const b = 1;\n');
        reviewed = commit('the branch', '2026-04-12T09:30:00Z');
    });
    afterEach(() => { fs.rmSync(repo, { recursive: true, force: true }); });

    it('builds the ledger from the last merged pull requests, the approved head included, runs it and leads with the two numbers', async () => {
        const calls: string[][] = [];
        const report = await backtestLast(repo, config, { last: 2, exec: fake(calls), collect: async () => ({ items: [item('a.ts', 1)], costUsd: 0.25 }) });
        expect(report).toMatchObject({ prs: 1, rounds: 3, approvedHeads: 1, pointsLater: 1, sameRound: 1, costUsd: 0.75 });
        expect(report.early).toEqual([{ pr: 7, round: 'pr7-r1', point: 'The export reads every line item.', by: 'reviewer:claude a.ts:1', roundsEarlier: 1 }]);
        expect(report.blocksOnApproved.map(b => b.round)).toEqual(['pr7-approved']);
        expect(report.skipped).toEqual(['pull request 6: pull request 6 has no review by a person yet']); // the author's own note is not a review
        expect(calls.filter(c => c[0] === 'git' && c[1] === 'fetch').map(c => c.at(-1))).toEqual(['pull/7/head', 'pull/6/head']);
        const written: Ledger = JSON.parse(fs.readFileSync(path.join(repo, LAST_LEDGER_PATH), 'utf8'));
        expect(written.rounds.map(r => [r.id, r.points.length])).toEqual([['pr7-r1', 1], ['pr7-r2', 1], ['pr7-approved', 0]]);
        expect(formatLast(report).split('\n')[0]).toContain('1 blocking item(s) on 1 approved head(s)');
    });

    it('gives the scaffolder the approved head only when asked, with no points', async () => {
        const calls: string[][] = [];
        const without = await roundsForPr(repo, 7, config, fake(calls));
        expect(without.approved).toBeUndefined();
        const withHead = await roundsForPr(repo, 7, config, fake(calls), { approvedHead: true });
        expect(withHead.approved).toMatchObject({ id: 'pr7-approved', commit: reviewed, reviewed_at: '2026-04-12T14:00:00Z', points: [] });
    });
});
