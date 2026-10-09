import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Exec } from '../review/reviewer/exec.js';
import { appendTaskEvent, readThread } from '../task/thread.js';
import { ConfigSchema } from '../types/index.js';
import { checkRunsCi, updatePrOutcomes, type CiResult, type PrOutcome } from './outcome.js';
import { localOutcomeMetrics, runOutcomes } from './run.js';

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

/**
 * Repositories built once for the file and copied into each test's own folder: every git command is a process,
 * slow to start on Windows, and the same history was built again for every test. A copy keeps each test's repository its own.
 */
let fixtures: string;
/** A copy skips git's transient files (locks, temporary objects), which may vanish while it reads them. */
const notTransient = (source: string) => !/\.lock$|[\\/]tmp_[^\\/]*$/.test(source);
const built = new Map<'merge' | 'squash', { mergeSha: string; mergedAt: string }>();

/** main with a.ts and b.ts; a pull request on `feature` that changes a.ts, merged on day 0 by `strategy`; then later commits on main. */
function history(strategy: 'merge' | 'squash'): { mergeSha: string; mergedAt: string } {
    const copy = path.join(fixtures, strategy);
    const done = built.get(strategy);
    if (done) {
        fs.rmSync(repo, { recursive: true, force: true });
        fs.cpSync(copy, repo, { recursive: true, filter: notTransient });
        return done;
    }
    const result = buildHistory(strategy);
    fs.cpSync(repo, copy, { recursive: true, filter: notTransient });
    built.set(strategy, result);
    return result;
}

function buildHistory(strategy: 'merge' | 'squash'): { mergeSha: string; mergedAt: string } {
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
async function prOutcome(pr: { number: number; mergeSha: string; mergedAt: string; branch: string; author: string }, options: { mainRef: string; windowDays: number; until: string; ci: (sha: string) => Promise<CiResult> }): Promise<PrOutcome> {
    fs.rmSync(path.join(repo, '.rigour', 'outcomes.json'), { force: true });
    return (await updatePrOutcomes(repo, [pr], options)).outcomes[0];
}
const stored = () => JSON.parse(fs.readFileSync(path.join(repo, '.rigour', 'outcomes.json'), 'utf8')).outcomes;
type Run = { name?: string; status: string; conclusion: string | null };
/** The CI result gh's check runs would give: `merge` on the merge commit, `before` on the commit before it. */
const ciFrom = (merge: Run[], before: Run[] = []) => checkRunsCi(repo, async (_c, args) => ({ exitCode: 0, stdout: JSON.stringify(args[2].includes('/abc^1/') ? before : merge), stderr: '' }))('abc', 'abc^1');

beforeAll(() => {
    fixtures = fs.mkdtempSync(path.join(os.tmpdir(), 'outcomes-fixtures-'));
    repo = path.join(fixtures, 'empty');
    fs.mkdirSync(repo);
    git(['init', '-q', '-b', 'main']);
    git(['config', 'user.email', 't@example.com']);
    git(['config', 'user.name', 't']);
    git(['config', 'commit.gpgsign', 'false']);
    // No background gc or maintenance after a commit: it writes and deletes files under .git while a test copies it.
    git(['config', 'gc.auto', '0']);
    git(['config', 'maintenance.auto', 'false']);
});
afterAll(() => { fs.rmSync(fixtures, { recursive: true, force: true }); });
beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'outcomes-'));
    fs.cpSync(path.join(fixtures, 'empty'), repo, { recursive: true, filter: notTransient });
});
afterEach(() => { fs.rmSync(repo, { recursive: true, force: true }); });

describe('the outcome of a merged pull request', () => {
    for (const strategy of ['merge', 'squash'] as const) {
        it(`reads its files, the later commits on them inside the window, and a revert, for a ${strategy} merge`, async () => {
            const { mergeSha, mergedAt } = history(strategy);
            const outcome = await prOutcome({ number: 7, mergeSha, mergedAt, branch: 'feature', author: 'ana' }, { mainRef: 'main', windowDays: 30, until: day(60), ci: ci('success') });
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
        const pr = { number: 7, mergeSha, mergedAt, branch: 'feature', author: 'ana' };
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
        const prs = [{ number: 7, mergeSha, mergedAt, branch: 'feature', author: 'ana' }];
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
        const outcome = await prOutcome({ number: 9, mergeSha, mergedAt: day(0), branch: 'feature', author: 'ana' }, { mainRef: 'main', windowDays: 30, until: day(60), ci: ci('success') });
        expect(outcome.files).toHaveLength(2000);
        expect(outcome.followUps.map(f => [f.subject, f.files])).toEqual([['fix: the last file', [files[1999]]]]);
    }, 60_000);

    it('reads main\'s log once for every pull request it brings up to date', async () => {
        const first = history('merge');
        git(['checkout', '-qb', 'second']);
        commit('b.ts', 'export const b = 9;\n', 'change b', day(46));
        git(['checkout', '-q', 'main']);
        git(['merge', '-q', '--no-ff', 'second', '-m', 'Merge pull request #8 from second'], day(47));
        const second = git(['rev-parse', 'HEAD']);
        commit('b.ts', 'export const b = 10;\n', 'fix: b again', day(50));
        const calls: string[][] = [];
        const counted = (args: string[]) => { calls.push(args); return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); };
        const { outcomes } = await updatePrOutcomes(repo, [
            { number: 7, ...first, branch: 'feature', author: 'ana' },
            { number: 8, mergeSha: second, mergedAt: day(47), branch: 'second', author: 'bo' },
        ], { mainRef: 'main', windowDays: 30, until: day(90), ci: ci('success'), git: counted });
        expect(calls.filter(args => args[0] === 'log')).toHaveLength(1);
        expect(outcomes.map(o => [o.pr, o.followUps.map(f => f.subject)])).toEqual([
            [7, ['fix: a was off by one', 'Revert "change a" (#7)']],
            [8, ['fix: b again']],
        ]);
    });

    it('reads the oldest merges first, and moves on from one read in the last 12 hours, so a deadline never starves the older ones', async () => {
        const first = history('merge');
        git(['checkout', '-qb', 'second']);
        commit('b.ts', 'export const b = 9;\n', 'change b', day(1));
        git(['checkout', '-q', 'main']);
        git(['merge', '-q', '--no-ff', 'second', '-m', 'Merge pull request #8 from second'], day(2));
        const prs = [
            { number: 8, mergeSha: git(['rev-parse', 'HEAD']), mergedAt: day(2), branch: 'second', author: 'bo' }, // newest first, as gh lists them
            { number: 7, ...first, branch: 'feature', author: 'ana' },
        ];
        const slow = (seen: string[]) => async (sha: string) => { seen.push(sha); await new Promise(resolve => setTimeout(resolve, 600)); return 'success' as const; };
        const seen: string[] = [];
        // Both windows open (day 10), and time for one read before the deadline.
        const cut = await updatePrOutcomes(repo, prs, { mainRef: 'main', windowDays: 30, until: day(10), ci: slow(seen), deadline: Date.now() + 300 });
        expect(cut).toMatchObject({ read: 1, stopped: expect.stringContaining('read deadline') });
        expect(seen).toEqual([first.mergeSha]); // #7, merged first
        const next = await updatePrOutcomes(repo, prs, { mainRef: 'main', windowDays: 30, until: new Date(Date.parse(day(10)) + 3_600_000).toISOString(), ci: slow(seen) });
        expect(next.read).toBe(1); // #8 only: #7 was read an hour ago
        expect(next.outcomes.map(o => o.pr)).toEqual([8, 7]); // in the order asked for
    });

    it('writes no thread for a branch this machine never worked on', async () => {
        const { mergeSha, mergedAt } = history('merge');
        await updatePrOutcomes(repo, [{ number: 7, mergeSha, mergedAt, branch: 'someone-else', author: 'ana' }], { mainRef: 'main', windowDays: 30, until: day(60), ci: ci('success') });
        expect(readThread(repo, 'someone-else')).toBeUndefined();
    });
});

describe('CI on the merge commit', () => {
    it('fails only on a check the merge broke: one that did not fail on the commit before it', async () => {
        const ok = { name: 'build', status: 'completed', conclusion: 'success' };
        expect(await ciFrom([ok, { name: 'tests', status: 'completed', conclusion: 'failure' }])).toBe('failure');
        expect(await ciFrom([ok, { name: 'tests', status: 'completed', conclusion: 'timed_out' }])).toBe('failure');
        // A security scan was already red on main: the merge broke nothing.
        expect(await ciFrom([ok, { name: 'security-scan', status: 'completed', conclusion: 'failure' }], [{ name: 'security-scan', status: 'completed', conclusion: 'failure' }])).toBe('success');
        expect(await ciFrom([])).toBe('none');
        expect(await ciFrom([ok, { name: 'e2e', status: 'in_progress', conclusion: null }])).toBe('pending');
        expect(await ciFrom([ok, { name: 'lint', status: 'completed', conclusion: 'skipped' }])).toBe('success');
        expect(await ciFrom([{ name: 'x', status: 'completed', conclusion: 'cancelled' }])).toBe('none');
    });

    it('reads every page of check runs, and the commit before the merge only when the merge has a failure', async () => {
        const seen: string[][] = [];
        const pages = [Array.from({ length: 100 }, (_, i) => ({ name: `job ${i}`, status: 'completed', conclusion: 'success' })), [{ name: 'job 100', status: 'completed', conclusion: 'failure' }]];
        const paged: Exec = async (_c, args) => { seen.push(args); return { exitCode: 0, stdout: args[2].includes('/abc^1/') ? '[]' : pages.map(p => JSON.stringify(p)).join('\n'), stderr: '' }; };
        expect(await checkRunsCi(repo, paged)('abc', 'abc^1')).toBe('failure');
        expect(seen.map(args => args.slice(0, 3))).toEqual([['api', '--paginate', 'repos/{owner}/{repo}/commits/abc/check-runs?per_page=100'], ['api', '--paginate', 'repos/{owner}/{repo}/commits/abc^1/check-runs?per_page=100']]);
        seen.length = 0;
        await checkRunsCi(repo, async (_c, args) => { seen.push(args); return { exitCode: 0, stdout: JSON.stringify([{ name: 'a', status: 'completed', conclusion: 'success' }]), stderr: '' }; })('abc', 'abc^1');
        expect(seen).toHaveLength(1);
    });

    it('is unavailable, never a throw and never "none", when gh fails or answers something that does not parse', async () => {
        expect(await checkRunsCi(repo, async () => ({ exitCode: 0, stdout: '[{"status":', stderr: '' }))('abc', 'abc^1')).toBe('unavailable');
        expect(await checkRunsCi(repo, async () => ({ exitCode: 1, stdout: '', stderr: 'HTTP 404' }))('abc', 'abc^1')).toBe('unavailable');
        expect(await checkRunsCi(repo, async () => { throw new Error('spawn gh ENOENT'); })('abc', 'abc^1')).toBe('unavailable');
        // A failure on the merge, and the commit before it unreadable: not known whether the merge broke it.
        const merge = JSON.stringify([{ name: 't', status: 'completed', conclusion: 'failure' }]);
        expect(await checkRunsCi(repo, async (_c, args) => (args[2].includes('/abc^1/') ? { exitCode: 1, stdout: '', stderr: 'HTTP 502' } : { exitCode: 0, stdout: merge, stderr: '' }))('abc', 'abc^1')).toBe('unavailable');
    });
});

describe('rigour outcomes', () => {
    it('applies what the records show to the team\'s review lessons, and writes them only when something changed', async () => {
        const { mergeSha, mergedAt } = history('merge');
        const file = path.join(repo, '.rigour', 'review-lessons.json');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        // An inline point on line 1 of a.ts, made on the pull request's last commit and left alone by it.
        const lesson = { id: 'L1', text: 'a is never off by one', file: 'a.ts', symbols: [], state: 'candidate', at: { commit: git(['rev-parse', 'feature']), start: 1, end: 1 }, evidence: [{ kind: 'point', pr: 7, comment: 'c7', author: 'rev', actedOn: false }], createdAt: day(-1), updatedAt: day(-1) };
        fs.writeFileSync(file, JSON.stringify({ version: 1, lessons: [lesson] }));
        const exec: Exec = async (_c, args) => {
            if (args[0] === 'pr') return { exitCode: 0, stdout: JSON.stringify({ number: 7, mergedAt, mergeCommit: { oid: mergeSha }, headRefName: 'feature', author: { login: 'ana' }, state: 'MERGED' }), stderr: '' };
            return { exitCode: 0, stdout: JSON.stringify([{ status: 'completed', conclusion: 'success' }]), stderr: '' };
        };
        // Two review rounds on the pull request: the first one's findings, and both rounds' dollars.
        appendTaskEvent(repo, { kind: 'review', pr: 7, outcome: 'findings', blocking: 1, should_fix: 1, checks: 2, cost_usd: 0.5, cost_basis: 'runs' });
        appendTaskEvent(repo, { kind: 'review', pr: 7, outcome: 'passed', blocking: 0, should_fix: 0, checks: 0, cost_usd: 0.25, cost_basis: 'runs' });
        const run = await runOutcomes(repo, ConfigSchema.parse({ version: 1 }), { flag: true, pr: 7, exec });
        expect(run.metrics?.model).toMatchObject({ share: { model: 2, checks: 2, prs: 1, rate: null }, costPerPr: { prs: 1, totalUsd: 0.75, medianUsd: null, prsEarlierBasis: 0 } });
        // One review event from before every run was counted: the pull request's dollars leave the sum, counted apart.
        appendTaskEvent(repo, { kind: 'review', pr: 7, outcome: 'passed', blocking: 0, should_fix: 0, cost_usd: 3 });
        expect(localOutcomeMetrics(repo)?.model.costPerPr).toMatchObject({ prs: 0, totalUsd: 0, prsEarlierBasis: 1 });
        // The fix on day 3 changed the point's own line.
        expect(run.lessons).toMatchObject({ added: 1, suggested: ['L1'] });
        expect(run.metrics).toMatchObject({ version: 1, records: { merged: 1, settled: 1 }, lessons: { awaitingDecision: 1 } });
        // Evidence for a person to look at in Studio, never a promotion.
        expect(JSON.parse(fs.readFileSync(file, 'utf8')).lessons[0]).toMatchObject({ state: 'candidate', evidence: [{ kind: 'point' }, { kind: 'lines' }] });
        const written = fs.statSync(file).mtimeMs;
        expect((await runOutcomes(repo, ConfigSchema.parse({ version: 1 }), { flag: true, pr: 7, exec })).lessons).toMatchObject({ added: 0 });
        expect(fs.statSync(file).mtimeMs).toBe(written);
    });

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
