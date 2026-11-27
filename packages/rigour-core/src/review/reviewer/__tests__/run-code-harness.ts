/**
 * What the run_code tests share: a repository and fake judges per test, an environment the test may change (restored
 * after, every CI variable cleared first since the suite may itself run in CI), and checks that a copy is gone.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, expect } from 'vitest';
import { CI_MARKERS } from '../../../telemetry/telemetry.js';
import { ConfigSchema } from '../../../types/index.js';
import { runReviewer, type ReviewerOptions, type ReviewerResult } from '../../reviewer.js';
import { defaultExec } from '../exec.js';
import { gitIn, installFakeJudges, makeRepo, type FakeJudges, type JudgeRun } from './judge-fakes.js';

/** `homes`: the CLIs' homes for the test; `made`: what a test creates besides, removed after it even when it fails. */
/**
 * run_code runs only on macOS, where its sandboxes were verified: every other platform keeps every judge read-only,
 * and run-code.test.ts asserts that refusal there. Tests of what a judge that runs code does are macOS-only, and say so.
 */
export const ON_MACOS = process.platform === 'darwin';
export const MACOS_ONLY = '(macOS only: run_code runs only where its sandboxes were verified)';
/** What only POSIX has (signals a process can catch, ps, lsof, /tmp): run_code never runs on Windows. */
export const ON_POSIX = process.platform !== 'win32';
export const POSIX_ONLY = '(POSIX only: run_code, which needs it, never runs on Windows)';

/** The team's rigour.yml on the base: run_code on. */
export const BASE_RUN_CODE = 'version: 1\nreview:\n  reviewer:\n    run_code: "on"\n';

export interface Harness { repo: string; judges: FakeJudges; homes: string; made: string[] }

export function runCodeHarness(): Harness {
    const h = { made: [] as string[] } as Harness;
    const saved: Record<string, string | undefined> = {};
    beforeEach(() => {
        h.judges = installFakeJudges();
        // run_code is read from the base (run-code-base.ts): the team turned it on on main.
        h.repo = makeRepo({ 'rigour.yml': BASE_RUN_CODE });
        // The CLIs' own homes, empty and the test's: nothing reads or edits this machine's Codex or Claude Code state.
        h.homes = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cli-homes-')));
        for (const dir of ['codex', 'claude', 'claude-tmp']) fs.mkdirSync(path.join(h.homes, dir));
        setEnv({ ...Object.fromEntries(CI_MARKERS.map(name => [name, undefined])), CODEX_HOME: path.join(h.homes, 'codex'), CLAUDE_CONFIG_DIR: path.join(h.homes, 'claude'), CLAUDE_CODE_TMPDIR: path.join(h.homes, 'claude-tmp') });
    });
    afterEach(() => {
        h.judges.remove();
        for (const [name, value] of Object.entries(saved)) value === undefined ? delete process.env[name] : (process.env[name] = value);
        for (const name of Object.keys(saved)) delete saved[name];
        for (const dir of [h.repo, h.homes, ...h.made.splice(0)]) fs.rmSync(dir, { recursive: true, force: true });
    });
    /** Sets or clears variables in this process's environment, restored after the test. */
    function setEnv(values: Record<string, string | undefined>): void {
        for (const [name, value] of Object.entries(values)) {
            if (!(name in saved)) saved[name] = process.env[name];
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
    }
    harnessEnv.set = setEnv;
    return h;
}

/** The current test's environment setter (runCodeHarness installs it). */
export const harnessEnv: { set: (values: Record<string, string | undefined>) => void } = { set: () => undefined };

export const runCodeConfig = (extra: Record<string, unknown> = {}) => ConfigSchema.parse({ version: 1, review: { coverage: false, reviewer: { enabled: true, reviewers: ['codex'], run_code: 'on', ...extra } } });

export const reviewIn = (repo: string, extra: Record<string, unknown> = {}, options: ReviewerOptions = {}): Promise<ReviewerResult> =>
    runReviewer(repo, 'main', runCodeConfig(extra), defaultExec, () => undefined, { blind: true, force: true, ...options });

/** Each run's copy is gone, its root with it, and the repository lists no worktree but its own. */
export function cleanedUp(repo: string, runs: JudgeRun[]): void {
    for (const run of runs) expect([fs.existsSync(run.cwd), fs.existsSync(path.dirname(run.cwd))]).toEqual([false, false]);
    expect(gitIn(repo, 'worktree', 'list', '--porcelain').split('\n').filter(line => line.startsWith('worktree ')).length).toBe(1);
}

/** A run's working directory is one of Rigour's throwaway copies (`<tmp>/rigour-judge-copy-XXXXXX/repo`). */
export const inCopy = (run: JudgeRun) => run.cwd.startsWith(fs.realpathSync(os.tmpdir())) && path.basename(path.dirname(run.cwd)).startsWith('rigour-judge-copy-') && path.basename(run.cwd) === 'repo';

/** Whether a process is gone. */
export function gone(pid: number | undefined): boolean {
    if (!pid) return false;
    try {
        process.kill(pid, 0);
        return false;
    } catch {
        return true;
    }
}
