import { execFileSync, spawn, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultExec } from './exec.js';
import { bigChange, EMPTY_VERDICT, gitIn } from './__tests__/judge-fakes.js';
import { cleanedUp, gone, harnessEnv, inCopy, MACOS_ONLY, ON_MACOS, reviewIn, runCodeHarness } from './__tests__/run-code-harness.js';
import { VerdictStore } from './store.js';
import { sweepStaleCopies } from './throwaway-copy.js';

// Whole reviews, some several: under a full suite's load, past 5 s.
vi.setConfig({ testTimeout: 60_000 });
const h = runCodeHarness();
const here = path.dirname(new URL(import.meta.url).pathname);

describe.runIf(ON_MACOS)(`run_code cleans up after itself ${MACOS_ONLY}`, () => {
    it('removes the copy when the judge fails, and when it times out: the judge and what it started are ended', async () => {
        h.judges.behave({ exitCode: 1 });
        expect((await reviewIn(h.repo)).outcome).toBe('unavailable');
        const failed = h.judges.runs();
        expect(failed).toHaveLength(2); // asked once more, in the same copy, reset
        expect(new Set(failed.map(run => run.cwd)).size).toBe(1);
        cleanedUp(h.repo, failed);

        h.judges.behave({ answer: JSON.stringify(EMPTY_VERDICT), sleepMs: 60_000, grandchild: true });
        const started = Date.now();
        expect((await reviewIn(h.repo, { timeout_ms: 1500 })).outcome).toBe('unavailable');
        expect(Date.now() - started).toBeLessThan(30_000);
        const timedOut = h.judges.runs().slice(2);
        expect(timedOut.length).toBeGreaterThan(0);
        cleanedUp(h.repo, timedOut);
        for (const run of timedOut) expect(gone(run.pid)).toBe(true);
        expect(gone(h.judges.grandchild())).toBe(true);
    });

    it('ends a nohup process the judge left running after it answered', async () => {
        h.judges.behave({ answer: JSON.stringify(EMPTY_VERDICT), grandchild: true });
        expect((await reviewIn(h.repo)).outcome).toBe('passed');
        expect(h.judges.grandchild()).toBeGreaterThan(0);
        expect(gone(h.judges.grandchild())).toBe(true);
    });

    it('ends a process the judge left running in a session of its own, as Claude Code\'s shell starts one, after it answered', async () => {
        h.judges.behave({ answer: JSON.stringify(EMPTY_VERDICT), grandchild: 'own-session' });
        expect((await reviewIn(h.repo)).outcome).toBe('passed');
        expect(h.judges.grandchild()).toBeGreaterThan(0);
        expect(gone(h.judges.grandchild())).toBe(true);
    });

    it('removes what Claude Code keeps under the copy\'s name in its temporary folder, and keeps no session of the copy', async () => {
        const claudeTmp = path.join(h.homes, 'claude-tmp', `claude-${process.getuid!()}`);
        fs.mkdirSync(path.join(claudeTmp, '-Users-dev-a-project', 'session'), { recursive: true });
        h.judges.behave({ answer: JSON.stringify(EMPTY_VERDICT), claudeTmp: true });
        expect((await reviewIn(h.repo, { reviewers: ['claude'] })).outcome).toBe('passed');
        const [run] = h.judges.runs();
        expect(run.argv).toContain('--no-session-persistence');
        expect(fs.readdirSync(claudeTmp)).toEqual(['-Users-dev-a-project']); // another session's kept
    });

    it('removes the trusted-project entry codex records for the copy, and nothing else in its config.toml', async () => {
        const config = 'model = "example-model"\n\n[projects."/Users/dev-a/project"]\ntrust_level = "trusted"\n';
        fs.writeFileSync(path.join(h.homes, 'codex', 'config.toml'), config);
        h.judges.behave({ answer: JSON.stringify(EMPTY_VERDICT), codexTrust: true });
        expect((await reviewIn(h.repo)).outcome).toBe('passed');
        expect(fs.readFileSync(path.join(h.homes, 'codex', 'config.toml'), 'utf8')).toBe(config);
    });

    it('runs orchestrated passes in at most two copies, all removed', async () => {
        bigChange(h.repo, 20);
        (await VerdictStore.open(h.repo, defaultExec))!.recordCost({ at: new Date().toISOString(), mode: 'orchestrator', lines: 1, projectedSingleChars: 10_000_000, actualChars: 0, actualUsd: 0, runs: 0 });
        const result = await reviewIn(h.repo, { timeout_ms: 60_000 }, { orchestrator: true });
        const runs = h.judges.runs();
        expect(result.mode?.specialists?.passes.length).toBe(runs.length);
        expect(runs.length).toBeGreaterThan(1);
        expect(new Set(runs.map(run => run.cwd)).size).toBeLessThanOrEqual(2);
        for (const run of runs) expect(inCopy(run)).toBe(true);
        cleanedUp(h.repo, runs);
    });

    /** A review in a process of its own, its judge running until killed; resolves once the judge and its child run. */
    async function reviewInChild(): Promise<{ child: ReturnType<typeof spawn>; exited: Promise<number | null> }> {
        h.judges.behave({ answer: JSON.stringify(EMPTY_VERDICT), sleepMs: 60_000, grandchild: true });
        const script = path.join(h.judges.dir, 'review.mts');
        fs.writeFileSync(script, [
            `import { runReviewer } from ${JSON.stringify(pathToFileURL(path.join(here, '..', 'reviewer.ts')).href)};`,
            `import { runCodeConfig } from ${JSON.stringify(pathToFileURL(path.join(here, '__tests__', 'run-code-harness.ts')).href)};`,
            `await runReviewer(${JSON.stringify(h.repo)}, 'main', runCodeConfig(), undefined, () => undefined, { blind: true, force: true });`,
        ].join('\n'));
        const child = spawn(process.execPath, ['--import', 'tsx', script], { cwd: path.join(here, '..', '..', '..'), stdio: 'ignore' });
        const exited = new Promise<number | null>(resolve => child.on('close', code => resolve(code)));
        for (let i = 0; i < 300 && !(h.judges.runs().length && h.judges.grandchild()); i++) await new Promise(r => setTimeout(r, 100));
        return { child, exited };
    }

    /** The folders in the temporary directory whose owner.json names `pid`: a review's copies and its input folder. */
    const ownedBy = (pid: number | undefined) => fs.readdirSync(os.tmpdir()).filter(name => /^rigour-(judge-copy|reviewer)-/.test(name)).filter(name => {
        try {
            return JSON.parse(fs.readFileSync(path.join(os.tmpdir(), name, 'owner.json'), 'utf8')).pid === pid;
        } catch {
            return false;
        }
    });

    for (const [signal, code] of [['SIGTERM', 143], ['SIGHUP', 129]] as const) {
        it(`on ${signal} to Rigour mid-run: ends the judge and what it started, removes the copy, and exits ${code}`, async () => {
            const { child, exited } = await reviewInChild();
            const [run] = h.judges.runs();
            expect(fs.existsSync(run.cwd)).toBe(true);
            expect(fs.existsSync(run.env.CLAUDE_CODE_TMPDIR)).toBe(true);
            child.kill(signal);
            expect(await exited).toBe(code);
            expect(fs.existsSync(path.dirname(run.cwd))).toBe(false);
            expect(gone(run.pid)).toBe(true);
            expect(gone(h.judges.grandchild())).toBe(true);
            expect(ownedBy(child.pid)).toEqual([]); // its input folder too
            expect(fs.existsSync(run.env.CLAUDE_CODE_TMPDIR)).toBe(false); // and the judge's temporary base
        });
    }

    it('when Rigour is killed outright (kill -9): its watchdog ends the judge, and the next review sweeps the copy', async () => {
        const { child, exited } = await reviewInChild();
        const [run] = h.judges.runs();
        child.kill('SIGKILL');
        await exited;
        for (let i = 0; i < 100 && !(gone(run.pid) && gone(h.judges.grandchild())); i++) await new Promise(r => setTimeout(r, 100));
        expect([gone(run.pid), gone(h.judges.grandchild())]).toEqual([true, true]);
        // Nothing in the killed review removed its copy; the next review's sweep does (a review in another test file may
        // run that sweep first, which is the point).
        sweepStaleCopies();
        expect(fs.existsSync(path.dirname(run.cwd))).toBe(false);
        expect(fs.existsSync(run.env.CLAUDE_CODE_TMPDIR)).toBe(false); // the judge's temporary base, named in its owner.json
        expect(ownedBy(child.pid)).toEqual([]);
    });
});

describe.runIf(ON_MACOS)(`a copy a killed review left behind ${MACOS_ONLY}`, () => {
    // A temporary directory of these tests' own: a review in another test file sweeps the shared one meanwhile.
    beforeEach(() => {
        const tmp = path.join(h.homes, 'tmp');
        fs.mkdirSync(tmp);
        harnessEnv.set({ TMPDIR: tmp });
    });

    /** A copy root as run_code makes one, owned by `owner` (none: a copy from before owners were written), `ageMs` old. */
    function copyRoot(owner: { pid: number; started: string } | undefined, ageMs = 0): string {
        const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rigour-judge-copy-')));
        h.made.push(root);
        gitIn(h.repo, 'clone', '--quiet', '--local', '--no-checkout', h.repo, path.join(root, 'repo'));
        if (owner) fs.writeFileSync(path.join(root, 'owner.json'), JSON.stringify({ ...owner, uid: process.getuid!() }));
        const then = (Date.now() - ageMs) / 1000;
        fs.utimesSync(root, then, then);
        return root;
    }
    const startedAt = (pid: number) => execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', LANG: 'C', TZ: 'UTC' } }).trim();
    /** A pid whose process has ended. */
    const deadPid = () => {
        const ended = spawnSync('sh', ['-c', 'echo $$']);
        return Number(String(ended.stdout).trim());
    };

    it('is swept only once its owner is gone, however old: a live owner\'s is kept, a reused pid\'s and an ownerless hour-old one go', async () => {
        const live = copyRoot({ pid: process.pid, started: startedAt(process.pid) }, 24 * 3_600_000);
        const dead = copyRoot({ pid: deadPid(), started: 'Thu Jan  1 00:00:00 2026' });
        const reused = copyRoot({ pid: process.pid, started: 'Thu Jan  1 00:00:00 2026' });
        const ownerless = copyRoot(undefined, 2 * 3_600_000);
        const young = copyRoot(undefined);
        const someoneElses = copyRoot({ pid: deadPid(), started: 'Thu Jan  1 00:00:00 2026' });
        fs.writeFileSync(path.join(someoneElses, 'owner.json'), JSON.stringify({ pid: deadPid(), started: '', uid: process.getuid!() + 1 }));
        expect(sweepStaleCopies().sort()).toEqual([dead, reused, ownerless].sort());
        expect([live, young, someoneElses].map(dir => fs.existsSync(dir))).toEqual([true, true, true]);
        const another = copyRoot({ pid: deadPid(), started: 'Thu Jan  1 00:00:00 2026' });
        await reviewIn(h.repo);
        expect(fs.existsSync(another)).toBe(false);
    });

    it('takes a judge\'s temporary base no live copy names once it is an hour old, this user\'s and private only', () => {
        const rgr = (ageMs: number, mode = 0o700) => {
            const dir = fs.mkdtempSync('/tmp/rgr-');
            h.made.push(dir);
            fs.chmodSync(dir, mode);
            const then = (Date.now() - ageMs) / 1000;
            fs.utimesSync(dir, then, then);
            return dir;
        };
        const named = rgr(2 * 3_600_000);
        const live = copyRoot({ pid: process.pid, started: startedAt(process.pid) });
        fs.writeFileSync(path.join(live, 'owner.json'), JSON.stringify({ pid: process.pid, started: startedAt(process.pid), uid: process.getuid!(), tmp: named }));
        const orphan = rgr(2 * 3_600_000);
        const young = rgr(60_000);
        const shared = rgr(2 * 3_600_000, 0o755);
        const owned = (pid: number, started: string) => {
            const dir = rgr(60_000);
            fs.writeFileSync(path.join(dir, 'owner.json'), JSON.stringify({ pid, started, uid: process.getuid!() }));
            return dir;
        };
        const ownerRuns = owned(process.pid, startedAt(process.pid));
        const ownerGone = owned(deadPid(), 'Thu Jan  1 00:00:00 2026');
        for (const dir of [ownerRuns, ownerGone]) fs.utimesSync(dir, (Date.now() - 2 * 3_600_000) / 1000, (Date.now() - 2 * 3_600_000) / 1000);
        sweepStaleCopies();
        expect([named, orphan, young, shared, ownerRuns, ownerGone].map(dir => fs.existsSync(dir))).toEqual([true, false, true, true, true, false]);
    });

    it('never removes a temporary base another user owns', async () => {
        const { removeCopy } = await import('./throwaway-copy.js');
        const tmp = fs.mkdtempSync('/tmp/rgr-');
        h.made.push(tmp);
        const stat = fs.statSync;
        const spy = vi.spyOn(fs, 'statSync').mockImplementation(((p: fs.PathLike, o?: fs.StatSyncOptions) => {
            const st = stat(p, o as fs.StatSyncOptions);
            return String(p) === tmp && st ? Object.assign(Object.create(Object.getPrototypeOf(st)), st, { uid: process.getuid!() + 1 }) : st;
        }) as typeof fs.statSync);
        try {
            removeCopy({ root: path.join(h.homes, 'no-root'), dir: path.join(h.homes, 'no-root', 'repo'), tmp });
        } finally {
            spy.mockRestore();
        }
        expect(fs.existsSync(tmp)).toBe(true);
    });

    it('leaves no temporary base behind when the copy cannot be made, nor when its root cannot be removed', async () => {
        const { makeCopy, removeCopy } = await import('./throwaway-copy.js');
        const made: string[] = [];
        const mkdtemp = fs.mkdtempSync;
        let failRoot = true;
        const spy = vi.spyOn(fs, 'mkdtempSync').mockImplementation(((prefix: string, o?: unknown) => {
            if (failRoot && String(prefix).includes('rigour-judge-copy-')) throw Object.assign(new Error('no space left'), { code: 'ENOSPC' });
            const dir = mkdtemp(prefix, o as BufferEncoding);
            made.push(dir);
            return dir;
        }) as typeof fs.mkdtempSync);
        try {
            await expect(makeCopy(h.repo, 'HEAD', defaultExec)).rejects.toThrow('no space left');
            expect(made.filter(dir => dir.startsWith('/tmp/rgr-'))).toHaveLength(1);
            expect(made.filter(dir => fs.existsSync(dir))).toEqual([]);
            failRoot = false;
            const copy = await makeCopy(h.repo, 'HEAD', defaultExec);
            if ('error' in copy) throw new Error(copy.error);
            const rm = fs.rmSync;
            const rmSpy = vi.spyOn(fs, 'rmSync').mockImplementation(((p: fs.PathLike, o?: fs.RmOptions) => {
                if (String(p) === copy.root) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
                return rm(p, o);
            }) as typeof fs.rmSync);
            try {
                expect(() => removeCopy(copy)).toThrow('busy');
            } finally {
                rmSpy.mockRestore();
            }
            expect(fs.existsSync(copy.tmp)).toBe(false); // the base went first
            removeCopy(copy);
        } finally {
            spy.mockRestore();
        }
    });

    it('takes nothing when ps cannot run: no owner can be told from a later process with its pid', () => {
        const dead = copyRoot({ pid: deadPid(), started: 'Thu Jan  1 00:00:00 2026' });
        const ownerless = copyRoot(undefined, 2 * 3_600_000);
        const path0 = process.env.PATH;
        process.env.PATH = h.homes; // no ps here
        try {
            expect(sweepStaleCopies()).toEqual([]);
        } finally {
            process.env.PATH = path0;
        }
        expect([fs.existsSync(dead), fs.existsSync(ownerless)]).toEqual([true, true]);
    });

    it('takes what the CLIs kept for it: codex\'s trust entry and Claude Code\'s folders; a live copy\'s and anyone else\'s stay', async () => {
        const live = path.join(copyRoot({ pid: process.pid, started: startedAt(process.pid) }), 'repo');
        const gone = path.join(path.dirname(live) + 'Zz', 'repo'); // a copy's path whose root no longer exists
        const others = 'model = "example-model"\n\n[projects."/Users/dev-a/project"]\ntrust_level = "trusted"\n';
        const entry = (p: string) => `\n[projects.${JSON.stringify(p)}]\ntrust_level = "trusted"\n`;
        fs.writeFileSync(path.join(h.homes, 'codex', 'config.toml'), others + entry(gone) + entry(live));
        const name = (p: string) => p.replace(/[^a-zA-Z0-9]/g, '-');
        const tmp = path.join(h.homes, 'claude-tmp', `claude-${process.getuid!()}`);
        const sessions = path.join(h.homes, 'claude', 'projects');
        for (const dir of [tmp, sessions]) for (const n of [name(gone), name(live), '-Users-dev-a-project']) fs.mkdirSync(path.join(dir, n), { recursive: true });
        await reviewIn(h.repo);
        expect(fs.readFileSync(path.join(h.homes, 'codex', 'config.toml'), 'utf8')).toBe(others + entry(live));
        for (const dir of [tmp, sessions]) expect(fs.readdirSync(dir).sort()).toEqual([name(live), '-Users-dev-a-project'].sort());
    });
});
