import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigSchema } from '../types/index.js';
import { backtestPassed, formatBacktest, ledgerProblems, loadLedger, runBacktest, score, LEDGER_PATH, type BacktestItem, type Ledger, type LedgerPoint, type LedgerRound } from './backtest.js';

const item = (over: Partial<BacktestItem> = {}): BacktestItem => ({ gate: 'unused-export', file: 'src/lib/server/billing/invoices.ts', line: 40, text: 'Unused export `isRefund` is not imported anywhere', blocking: true, ...over });

describe('a ledger point matches a finding', () => {
    const caught = (row: Omit<LedgerPoint, 'id' | 'point'>, finding: BacktestItem) =>
        score({ id: 'r', commit: 'abcdef0', base: 'main', points: [{ id: 'P', point: 'p', ...row }], must_not_flag: [] }, 'h', [finding], 0, undefined).points[0].caught;

    it('by file, then by line window or text pattern, case-insensitively', () => {
        expect(caught({ file: 'invoices', lines: [30, 50] }, item())).toBe(true);
        expect(caught({ file: 'invoices', lines: [41, 50] }, item())).toBe(false);
        expect(caught({ file: 'invoices', text: 'isrefund|twice' }, item())).toBe(true);
        expect(caught({ file: 'invoices', lines: [41, 50], text: 'isRefund' }, item())).toBe(true); // either is enough
        expect(caught({ file: 'receipts', text: 'isRefund' }, item())).toBe(false); // the file must match
        expect(caught({ file: 'invoices', lines: [30, 50] }, item({ line: undefined }))).toBe(false); // a lineless finding cannot be placed in a window
    });

    it('rejects rows that can match nothing before any round runs', () => {
        const ledger: Ledger = { rounds: [{ id: 'r1', commit: 'abcdef0', base: 'main', points: [
            { id: 'A', point: 'p', file: 'x', lines: [1, 2] },
            { id: 'B', point: 'p', file: '', text: 'x' },
            { id: 'C', point: 'p', file: 'x' },
            { id: 'D', point: 'p', file: 'x', text: 'x', needs: 'a text pattern' },
            { id: 'E', point: 'p', file: '[', text: 'x' },
        ], must_not_flag: [{ file: 'x' }] }] };
        expect(ledgerProblems(ledger)).toEqual([
            'r1 B: no file pattern',
            'r1 C: needs a line window or a text pattern',
            'r1 D: needs a text pattern',
            'r1 E: not a regular expression',
            'r1 must_not_flag[0]: needs a line window or a text pattern',
        ]);
    });
});

describe('scoring a round', () => {
    const round: LedgerRound = {
        id: 'r1', commit: 'abcdef0', base: 'main',
        points: [
            { id: 'P1', point: 'dead export', file: 'invoices', lines: [30, 50] },
            { id: 'P2', point: 'copies the accumulator', file: 'totals', text: 'copied|quadratic' },
            { id: 'P3', point: 'drops the currency', file: 'checkout', text: 'currency' },
        ],
        must_not_flag: [{ file: 'session', text: 'cookie' }],
    };

    it('counts a point as caught only by a blocking finding; an advisory match is noted and still missed', () => {
        const items = [item(), item({ gate: 'quadratic-copy', file: 'src/totals.ts', line: 128, text: 'accumulator copied whole', blocking: false }), item({ gate: 'reviewer', file: 'src/hooks/session.ts', line: 53, text: 'the cookie is cleared' })];
        const result = score(round, 'abcdef0123456', items, 1200, undefined);
        expect(result.points).toEqual([
            { id: 'P1', point: 'dead export', caught: true, noted: false, by: 'unused-export src/lib/server/billing/invoices.ts:40' },
            { id: 'P2', point: 'copies the accumulator', caught: false, noted: true },
            { id: 'P3', point: 'drops the currency', caught: false, noted: false },
        ]);
        expect(result.falseBlocks).toHaveLength(1);
        expect(backtestPassed([result])).toBe(false);
        expect(formatBacktest([result])).toContain('r1 at abcdef012: 1/3 caught, 1 false block(s), 3 finding(s), 1s; caught by unused-export 1');
        expect(formatBacktest([result])).toContain('noted   P2 copies the accumulator (advisory only)');
        expect(formatBacktest([result])).toContain('MISSED  P3');
        expect(formatBacktest([result])).toContain('FALSE   reviewer src/hooks/session.ts:53');
    });

    it('passes only when every point is caught, nothing good is flagged and the reviewer answered', () => {
        const all = [item(), item({ gate: 'quadratic-copy', file: 'src/totals.ts', text: 'copied whole' }), item({ gate: 'reviewer', file: 'src/checkout.ts', text: 'drops the currency' })];
        expect(backtestPassed([score(round, 'h', all, 1, undefined)])).toBe(true);
        expect(backtestPassed([score(round, 'h', all, 1, 'the reviewer did not answer')])).toBe(false);
    });
});

describe('rigour backtest on a repository', () => {
    let repo: string;
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
    const write = (rel: string, body: string) => {
        fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
        fs.writeFileSync(path.join(repo, rel), body);
    };

    beforeEach(() => {
        repo = fs.mkdtempSync(path.join(os.tmpdir(), 'backtest-'));
        git('init', '-q', '-b', 'main');
        git('config', 'user.email', 't@example.com');
        git('config', 'user.name', 't');
        git('config', 'commit.gpgsign', 'false');
        write('src/app.ts', 'export const app = 1;\n');
        git('add', '-A');
        git('commit', '-qm', 'base');
        git('checkout', '-qb', 'feature');
        write('src/lib/util.ts', 'export function helper(): number {\n    return 1;\n}\n');
        git('add', '-A');
        git('commit', '-qm', 'add a helper nothing uses');
    });
    afterEach(() => {
        try { git('worktree', 'prune'); } catch { /* the repository may be gone */ }
        fs.rmSync(repo, { recursive: true, force: true });
    });

    it('hides the review itself for a round, and shows the approval for an approved head', async () => {
        const commit = git('rev-parse', 'HEAD');
        const base = git('rev-parse', 'main');
        const lines: string[] = [];
        const ledger: Ledger = { rounds: [
            { id: 'r1', commit, base, reviewed_at: '2026-09-28T15:12:53Z', points: [], must_not_flag: [] },
            { id: 'pr1-approved', commit, base, reviewed_at: '2026-09-28T15:12:53Z', approved: true, points: [], must_not_flag: [] },
            { id: 'odd', commit, base, reviewed_at: 'not a date', approved: true, points: [], must_not_flag: [] },
        ] };
        await runBacktest(repo, ConfigSchema.parse({ version: 1 }), ledger, { progress: line => lines.push(line), collect: async () => ({ items: [] }) });
        expect(lines.filter(l => l.includes('reviews hidden from')).map(l => l.replace(/^.*reviews hidden from /, ''))).toEqual(['2026-09-28T15:12:53Z', '2026-09-28T15:12:54.000Z', 'not a date']);
    }, 60_000);

    it('reviews the reviewed commit in a worktree with the review hidden, scores it, and leaves the checkout alone', async () => {
        const reviewed = git('rev-parse', 'HEAD');
        const base = git('rev-parse', 'main');
        git('checkout', '-q', 'main'); // the person runs it from wherever they are
        write(LEDGER_PATH, JSON.stringify({ rounds: [{
            id: 'r1', commit: reviewed, base,
            points: [
                { id: 'R1-1', point: 'helper is never imported', file: 'util\\.ts', lines: [1, 3] },
                { id: 'R1-2', point: 'something no gate knows', file: 'util', text: 'quadratic' },
            ],
            must_not_flag: [{ file: 'app\\.ts', lines: [1, 1] }],
        }] }));
        const config = ConfigSchema.parse({ version: 1, gates: { unused_exports: { block: true } } });
        const results = await runBacktest(repo, config, loadLedger(repo), { progress: () => undefined });
        expect(results).toHaveLength(1);
        expect(results[0].points).toMatchObject([{ id: 'R1-1', caught: true, by: 'unused-export src/lib/util.ts:1' }, { id: 'R1-2', caught: false, noted: false }]);
        expect(results[0].falseBlocks).toEqual([]);
        expect(results[0].head).toBe(reviewed);
        expect(backtestPassed(results)).toBe(false);
        expect(git('branch', '--show-current')).toBe('main');
        expect(fs.existsSync(path.join(repo, 'src/lib/util.ts'))).toBe(false); // the checkout did not move
        expect(fs.existsSync(path.join(repo, '.git/rigour-backtest/checkout/src/lib/util.ts'))).toBe(true);
        expect(fs.readdirSync(path.join(repo, '.rigour/backtest'))).toEqual([`r1-${reviewed.slice(0, 12)}.json`]);
        // The worktree is reused on the next run.
        const again = await runBacktest(repo, config, loadLedger(repo), { round: 'r1', progress: () => undefined });
        expect(again[0].points[0].caught).toBe(true);
    }, 60_000); // a real worktree and a typed review: over 10s on a Windows runner

    it('warns when the base is older than the main the head already merged in', async () => {
        const forked = git('rev-parse', 'main');
        git('checkout', '-q', 'main');
        write('src/main-only.ts', 'export const later = 1;\n');
        git('add', '-A');
        git('commit', '-qm', 'main moves on');
        const merged = git('rev-parse', 'HEAD');
        git('checkout', '-q', 'feature');
        git('merge', '-q', '--no-edit', 'main');
        const reviewed = git('rev-parse', 'HEAD');
        const config = ConfigSchema.parse({ version: 1 });
        const run = async (base: string) => {
            const lines: string[] = [];
            const ledger: Ledger = { rounds: [{ id: 'r1', commit: reviewed, base, points: [], must_not_flag: [] }] };
            await runBacktest(repo, config, ledger, { progress: line => lines.push(line), collect: async () => ({ items: [] }) });
            return lines.filter(line => line.includes('warning'));
        };
        expect(await run(forked)).toEqual([expect.stringContaining(`set the base to ${merged.slice(0, 9)}`)]);
        expect(await run(merged)).toEqual([]);
        git('update-ref', 'refs/heads/main', forked); // a local main older than the round's base: the ref is stale, not the base
        expect(await run(merged)).toEqual([]);
        git('update-ref', 'refs/heads/main', merged);
        git('checkout', '-q', 'main');
        git('merge', '-q', '--no-edit', 'feature'); // the pull request is merged: its head is on main now
        expect(await run(merged)).toEqual([]);
    }, 60_000);

    it('moves one worktree from round to round, leaving nothing of the last round behind', async () => {
        const reviewed = git('rev-parse', 'HEAD');
        const base = git('rev-parse', 'main');
        const seen: Array<{ tree: string; util: boolean; leftover: boolean }> = [];
        const ledger: Ledger = { rounds: [
            { id: 'after', commit: reviewed, base, points: [], must_not_flag: [] },
            { id: 'before', commit: base, base, points: [], must_not_flag: [] },
        ] };
        await runBacktest(repo, ConfigSchema.parse({ version: 1 }), ledger, { progress: () => undefined, collect: async tree => {
            seen.push({ tree, util: fs.existsSync(path.join(tree, 'src/lib/util.ts')), leftover: fs.existsSync(path.join(tree, 'scratch.txt')) });
            fs.writeFileSync(path.join(tree, 'scratch.txt'), 'left by a round');
            return { items: [] };
        } });
        expect(seen.map(s => s.tree)).toEqual([seen[0].tree, seen[0].tree]);
        expect(seen.map(s => [s.util, s.leftover])).toEqual([[true, false], [false, false]]);
    }, 60_000);

    it('names a round or a commit it cannot find', async () => {
        const config = ConfigSchema.parse({ version: 1 });
        const ledger: Ledger = { rounds: [{ id: 'r1', commit: '0000000000000000000000000000000000000000', base: 'main', points: [{ id: 'P', point: 'p', file: 'x', text: 'x' }], must_not_flag: [] }] };
        await expect(runBacktest(repo, config, ledger, { round: 'r9' })).rejects.toThrow('no round "r9"');
        await expect(runBacktest(repo, config, ledger, { progress: () => undefined })).rejects.toThrow('is not in this repository');
        expect(() => loadLedger(repo)).toThrow('no ledger');
    }, 60_000); // a real worktree and a typed review: over 10s on a Windows runner
});
