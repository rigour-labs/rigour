import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { describe, expect, it, vi } from 'vitest';
import { defaultExec } from './exec.js';
import { bigChange, EMPTY_VERDICT, gitIn, makeRepo } from './__tests__/judge-fakes.js';
import { cleanedUp, gone, harnessEnv, inCopy, reviewIn, runCodeHarness } from './__tests__/run-code-harness.js';
import { VerdictStore } from './store.js';
import { sweepStaleCopies } from './throwaway-copy.js';

// Whole reviews, some several: under a full suite's load, past 5 s.
vi.setConfig({ testTimeout: 60_000 });
const h = runCodeHarness();
const here = path.dirname(new URL(import.meta.url).pathname);

describe('run_code cleans up after itself', () => {
    it('removes the copy when the judge fails, and when it times out: the judge and what it started are ended', async () => {
        h.judges.behave({ exitCode: 1 });
        expect((await reviewIn(h.repo)).outcome).toBe('unavailable');
        const failed = h.judges.runs();
        expect(failed).toHaveLength(2); // asked once more: each run its own copy
        expect(new Set(failed.map(run => run.cwd)).size).toBe(2);
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
        const tmpBase = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-tmp-base-')));
        const other = path.join(tmpBase, `claude-${process.getuid!()}`, '-Users-dev-a-project', 'session');
        fs.mkdirSync(other, { recursive: true });
        harnessEnv.set({ CLAUDE_CODE_TMPDIR: tmpBase });
        h.judges.behave({ answer: JSON.stringify(EMPTY_VERDICT), claudeTmp: true });
        expect((await reviewIn(h.repo, { reviewers: ['claude'] })).outcome).toBe('passed');
        const [run] = h.judges.runs();
        expect(run.argv).toContain('--no-session-persistence');
        expect(fs.readdirSync(path.join(tmpBase, `claude-${process.getuid!()}`))).toEqual(['-Users-dev-a-project']); // another session's kept
        fs.rmSync(tmpBase, { recursive: true, force: true });
    });

    it('removes the trusted-project entry codex records for the copy, and nothing else in its config.toml', async () => {
        const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
        const config = 'model = "example-model"\n\n[projects."/Users/dev-a/project"]\ntrust_level = "trusted"\n';
        fs.writeFileSync(path.join(codexHome, 'config.toml'), config);
        harnessEnv.set({ CODEX_HOME: codexHome });
        h.judges.behave({ answer: JSON.stringify(EMPTY_VERDICT), codexTrust: true });
        expect((await reviewIn(h.repo)).outcome).toBe('passed');
        expect(fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8')).toBe(config);
        fs.rmSync(codexHome, { recursive: true, force: true });
    });

    it('gives each orchestrated pass its own copy, all removed', async () => {
        bigChange(h.repo, 20);
        (await VerdictStore.open(h.repo, defaultExec))!.recordCost({ at: new Date().toISOString(), mode: 'orchestrator', lines: 1, projectedSingleChars: 10_000_000, actualChars: 0, actualUsd: 0, runs: 0 });
        const result = await reviewIn(h.repo, { timeout_ms: 60_000 }, { orchestrator: true });
        const runs = h.judges.runs();
        expect(result.mode?.specialists?.passes.length).toBe(runs.length);
        expect(runs.length).toBeGreaterThan(1);
        expect(new Set(runs.map(run => run.cwd)).size).toBe(runs.length);
        for (const run of runs) expect(inCopy(run)).toBe(true);
        cleanedUp(h.repo, runs);
    });

    it('on SIGTERM to Rigour mid-run: ends the judge and what it started, removes the copy, and exits 143', async () => {
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
        const [run] = h.judges.runs();
        expect(fs.existsSync(run.cwd)).toBe(true);
        child.kill('SIGTERM');
        expect(await exited).toBe(143);
        expect(fs.existsSync(run.cwd)).toBe(false);
        expect(gone(run.pid)).toBe(true);
        expect(gone(h.judges.grandchild())).toBe(true);
    });
});

describe('a copy a killed review left behind', () => {
    /** A copy of `repo` as run_code makes one, `ageMs` old. */
    function copyOf(repo: string, ageMs: number): string {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rigour-judge-copy-'));
        gitIn(repo, 'clone', '--quiet', '--shared', '--no-checkout', repo, dir);
        const then = (Date.now() - ageMs) / 1000;
        fs.utimesSync(dir, then, then);
        return dir;
    }

    it('is swept at the next run_code review once it is older than the judge\'s timeout; a younger one and another repository\'s are kept', async () => {
        const other = makeRepo();
        const stale = copyOf(h.repo, 20 * 60_000);
        const fresh = copyOf(h.repo, 1000);
        const otherRepo = copyOf(other, 20 * 60_000);
        expect(sweepStaleCopies(h.repo, 15 * 60_000)).toEqual([stale]);
        expect([fs.existsSync(stale), fs.existsSync(fresh), fs.existsSync(otherRepo)]).toEqual([false, true, true]);
        const another = copyOf(h.repo, 20 * 60_000);
        await reviewIn(h.repo);
        expect(fs.existsSync(another)).toBe(false);
        for (const dir of [fresh, otherRepo, other]) fs.rmSync(dir, { recursive: true, force: true });
    });
});
