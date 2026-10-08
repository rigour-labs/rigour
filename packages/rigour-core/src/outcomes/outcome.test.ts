import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Exec } from '../review/reviewer/exec.js';
import { appendTaskEvent, readThread } from '../task/thread.js';
import { ConfigSchema } from '../types/index.js';
import { checkRunsCi, updatePrOutcomes, type CiResult, type PrOutcome } from './outcome.js';
import { runOutcomes } from './run.js';

let repo: string;
const day = (n: number) => new Date(Date.UTC(2026, 8, 1) + n * 86_400_000).toISOString();
function git(args: string[], at?: string): string {
    return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: { ...process.env, ...(at ? { GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at } : {}) } }).trim();
}
function commit(file: string, text: string, subject: string, at: string): string {
    fs.writeFileSync(path.join(repo, file), text);
    git(['add', '-A']);
    git(['commit', '-qm', subject], at);
    return git(['rev-parse', 'HEAD']);
}

/** main with a.ts and b.ts; a pull request on `feature` that changes a.ts, merged on day 0 by `strategy`; then later commits on main. */
function history(strategy: 'merge' | 'squash'): { mergeSha: string; mergedAt: string } {
    commit('a.ts', 'export const a = 1;\n', 'init', day(-10));
    commit('b.ts', 'export const b = 1;\n', 'add b', day(-10));
    git(['checkout', '-qb', 'feature']);
    appendTaskEvent(repo, { kind: 'push', passed: true, failed: 0 }); // this machine worked on the branch: it has a thread
    commit('a.ts', 'export const a = 2;\n', 'change a', day(-2));
    git(['checkout', '-q', 'main']);
    if (strategy === 'merge') git(['merge', '-q', '--no-ff', 'feature', '-m', 'Merge pull request #7 from feature'], day(0));
    else {
        git(['merge', '-q', '--squash', 'feature']);
        git(['commit', '-qm', 'change a (#7)'], day(0));
    }
    const mergeSha = git(['rev-parse', 'HEAD']);
    commit('a.ts', 'export const a = 3;\n', 'fix: a was off by one', day(3));
    commit('b.ts', 'export const b = 2;\n', 'fix: b, not this pull request\'s file', day(4));
    commit('a.ts', 'export const a = 2;\n', 'Revert "change a" (#7)', day(10));
    commit('a.ts', 'export const a = 4;\n', 'fix: after the window', day(45));
    return { mergeSha, mergedAt: day(0) };
}

const ci = (result: CiResult, calls: string[] = []) => async (sha: string) => { calls.push(sha); return result; };

/** One pull request's outcome, read fresh (no store from an earlier read). */
async function prOutcome(pr: { number: number; mergeSha: string; mergedAt: string; branch: string }, options: { mainRef: string; windowDays: number; until: string; ci: (sha: string) => Promise<CiResult> }): Promise<PrOutcome> {
    fs.rmSync(path.join(repo, '.rigour', 'outcomes.json'), { force: true });
    return (await updatePrOutcomes(repo, [pr], options)).outcomes[0];
}
const stored = () => JSON.parse(fs.readFileSync(path.join(repo, '.rigour', 'outcomes.json'), 'utf8')).outcomes;
/** The CI result gh's check runs would give. */
const ciFrom = (runs: Array<{ status: string; conclusion: string | null }>) => checkRunsCi(repo, async () => ({ exitCode: 0, stdout: JSON.stringify(runs), stderr: '' }))('abc');

beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'outcomes-'));
    git(['init', '-q', '-b', 'main']);
    git(['config', 'user.email', 't@example.com']);
    git(['config', 'user.name', 't']);
    git(['config', 'commit.gpgsign', 'false']);
});
afterEach(() => { fs.rmSync(repo, { recursive: true, force: true }); });

describe('the outcome of a merged pull request', () => {
    for (const strategy of ['merge', 'squash'] as const) {
        it(`reads its files, the later commits on them inside the window, and a revert, for a ${strategy} merge`, async () => {
            const { mergeSha, mergedAt } = history(strategy);
            const outcome = await prOutcome({ number: 7, mergeSha, mergedAt, branch: 'feature' }, { mainRef: 'main', windowDays: 30, until: day(60), ci: ci('success') });
            expect(outcome.files).toEqual(['a.ts']);
            // b.ts is not the pull request's file; day 45 is after the window.
            expect(outcome.followUps.map(f => [f.subject, f.fix, f.files])).toEqual([
                ['fix: a was off by one', true, ['a.ts']],
                ['Revert "change a" (#7)', true, ['a.ts']],
            ]);
            expect(outcome.reverted?.subject).toBe('Revert "change a" (#7)');
            expect(outcome).toMatchObject({ ci: 'success', settled: true, windowEnd: day(30) });
        });
    }

    it('is not settled while the window is open, or while CI is pending or unreadable', async () => {
        const { mergeSha, mergedAt } = history('merge');
        const pr = { number: 7, mergeSha, mergedAt, branch: 'feature' };
        const open = await prOutcome(pr, { mainRef: 'main', windowDays: 30, until: day(5), ci: ci('success') });
        expect(open).toMatchObject({ settled: false, windowEnd: day(5) });
        expect(open.followUps.map(f => f.subject)).toEqual(['fix: a was off by one']); // nothing after `until`
        for (const result of ['pending', 'unavailable'] as const) {
            expect((await prOutcome(pr, { mainRef: 'main', windowDays: 30, until: day(60), ci: ci(result) })).settled).toBe(false);
        }
        expect((await prOutcome(pr, { mainRef: 'main', windowDays: 30, until: day(60), ci: ci('none') })).settled).toBe(true);
    });

    it('keeps a settled record without reading it again, records merge and outcome on the branch\'s thread once, and stops at a deadline', async () => {
        const { mergeSha, mergedAt } = history('merge');
        const prs = [{ number: 7, mergeSha, mergedAt, branch: 'feature' }];
        const calls: string[] = [];
        const options = { mainRef: 'main', windowDays: 30, until: day(60), ci: ci('failure', calls) };
        expect((await updatePrOutcomes(repo, prs, options)).read).toBe(1);
        expect((await updatePrOutcomes(repo, prs, options)).read).toBe(0);
        expect(calls).toEqual([mergeSha]);
        expect(stored()[mergeSha]).toMatchObject({ pr: 7, ci: 'failure', settled: true });
        const events = readThread(repo, 'feature')!.events.filter(e => e.kind === 'merge' || e.kind === 'outcome');
        expect(events.map(e => [e.kind, e.pr])).toEqual([['merge', 7], ['outcome', 7]]);
        expect(events[1]).toMatchObject({ ci: 'failure', follow_ups: 2, fixes: 2, reverted: true });
        fs.rmSync(path.join(repo, '.rigour', 'outcomes.json'));
        const late = await updatePrOutcomes(repo, prs, { ...options, deadline: Date.now() - 1 });
        expect(late).toMatchObject({ read: 0, stopped: expect.stringContaining('read deadline') });
    });

    it('finds the later commits of a pull request with thousands of files, past any command-line limit', async () => {
        commit('a.ts', 'export const a = 1;\n', 'init', day(-10));
        git(['checkout', '-qb', 'feature']);
        const files = Array.from({ length: 2000 }, (_, i) => `src/a-rather-long-module-folder-name/another-long-subfolder-name/generated-file-number-${i}.ts`);
        fs.mkdirSync(path.join(repo, path.dirname(files[0])), { recursive: true });
        for (const file of files) fs.writeFileSync(path.join(repo, file), `export const n = ${file.length};\n`);
        git(['add', '-A']);
        git(['commit', '-qm', 'many files'], day(-1));
        git(['checkout', '-q', 'main']);
        git(['merge', '-q', '--no-ff', 'feature', '-m', 'Merge pull request #9'], day(0));
        const mergeSha = git(['rev-parse', 'HEAD']);
        commit(files[1999], 'export const n = 0;\n', 'fix: the last file', day(2));
        const outcome = await prOutcome({ number: 9, mergeSha, mergedAt: day(0), branch: 'feature' }, { mainRef: 'main', windowDays: 30, until: day(60), ci: ci('success') });
        expect(outcome.files).toHaveLength(2000);
        expect(outcome.followUps.map(f => [f.subject, f.files])).toEqual([['fix: the last file', [files[1999]]]]);
    }, 60_000);

    it('writes no thread for a branch this machine never worked on', async () => {
        const { mergeSha, mergedAt } = history('merge');
        await updatePrOutcomes(repo, [{ number: 7, mergeSha, mergedAt, branch: 'someone-else' }], { mainRef: 'main', windowDays: 30, until: day(60), ci: ci('success') });
        expect(readThread(repo, 'someone-else')).toBeUndefined();
    });
});

describe('CI on the merge commit', () => {
    it('fails on any failed or timed-out run, waits on one still going, and ignores cancelled and skipped runs', async () => {
        expect(await ciFrom([])).toBe('none');
        expect(await ciFrom([{ status: 'completed', conclusion: 'success' }, { status: 'completed', conclusion: 'failure' }])).toBe('failure');
        expect(await ciFrom([{ status: 'completed', conclusion: 'timed_out' }])).toBe('failure');
        expect(await ciFrom([{ status: 'completed', conclusion: 'success' }, { status: 'in_progress', conclusion: null }])).toBe('pending');
        expect(await ciFrom([{ status: 'completed', conclusion: 'success' }, { status: 'completed', conclusion: 'skipped' }])).toBe('success');
        expect(await ciFrom([{ status: 'completed', conclusion: 'cancelled' }])).toBe('none');
    });

    it('reads every page of check runs: a failure on page two is a failure', async () => {
        const seen: string[][] = [];
        const pages = [Array.from({ length: 100 }, () => ({ status: 'completed', conclusion: 'success' })), [{ status: 'completed', conclusion: 'failure' }]];
        const paged: Exec = async (_c, args) => { seen.push(args); return { exitCode: 0, stdout: pages.map(p => JSON.stringify(p)).join('\n'), stderr: '' }; };
        expect(await checkRunsCi(repo, paged)('abc')).toBe('failure');
        expect(seen[0].slice(0, 3)).toEqual(['api', '--paginate', 'repos/{owner}/{repo}/commits/abc/check-runs?per_page=100']);
    });

    it('is unavailable, never a throw and never "none", when gh fails or answers something that does not parse', async () => {
        expect(await checkRunsCi(repo, async () => ({ exitCode: 0, stdout: '[{"status":', stderr: '' }))('abc')).toBe('unavailable');
        expect(await checkRunsCi(repo, async () => ({ exitCode: 1, stdout: '', stderr: 'HTTP 404' }))('abc')).toBe('unavailable');
        expect(await checkRunsCi(repo, async () => { throw new Error('spawn gh ENOENT'); })('abc')).toBe('unavailable');
    });
});

describe('rigour outcomes', () => {
    it('reads nothing, and asks GitHub nothing, with the outcome loop off', async () => {
        const calls: string[][] = [];
        const run = await runOutcomes(repo, ConfigSchema.parse({ version: 1 }), { exec: async (_c, args) => { calls.push(args); return { exitCode: 1, stdout: '', stderr: '' }; } });
        expect(run).toMatchObject({ switch: { enabled: false }, read: 0, stopped: expect.stringContaining('the outcome loop is off') });
        expect(calls).toEqual([]);
    });

    it('reads one merged pull request with the loop on for this run', async () => {
        const { mergeSha, mergedAt } = history('squash');
        const exec: Exec = async (_c, args) => {
            if (args[0] === 'pr') return { exitCode: 0, stdout: JSON.stringify({ number: 7, mergedAt, mergeCommit: { oid: mergeSha }, headRefName: 'feature', state: 'MERGED' }), stderr: '' };
            if (args[0] === 'api') return { exitCode: 0, stdout: JSON.stringify([{ status: 'completed', conclusion: 'success' }]), stderr: '' };
            return { exitCode: 1, stdout: '', stderr: 'unexpected' };
        };
        const run = await runOutcomes(repo, ConfigSchema.parse({ version: 1 }), { flag: true, pr: 7, exec });
        expect(run.switch).toMatchObject({ enabled: true, source: 'flag' });
        expect(run.outcomes.map(o => [o.pr, o.ci, o.files, o.followUps.length, o.settled])).toEqual([[7, 'success', ['a.ts'], 2, true]]); // merged in September 2026: the window has closed, day 45 is outside it
    });
});
