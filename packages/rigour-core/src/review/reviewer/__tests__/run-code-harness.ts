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

export interface Harness { repo: string; judges: FakeJudges }

export function runCodeHarness(): Harness {
    const h = {} as Harness;
    const saved: Record<string, string | undefined> = {};
    beforeEach(() => {
        h.judges = installFakeJudges();
        h.repo = makeRepo();
        setEnv(Object.fromEntries(CI_MARKERS.map(name => [name, undefined])));
    });
    afterEach(() => {
        h.judges.remove();
        for (const [name, value] of Object.entries(saved)) value === undefined ? delete process.env[name] : (process.env[name] = value);
        for (const name of Object.keys(saved)) delete saved[name];
        fs.rmSync(h.repo, { recursive: true, force: true });
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

/** Each run's working copy is gone, and the repository lists no worktree but its own. */
export function cleanedUp(repo: string, runs: JudgeRun[]): void {
    for (const run of runs) expect(fs.existsSync(run.cwd)).toBe(false);
    expect(gitIn(repo, 'worktree', 'list', '--porcelain').split('\n').filter(line => line.startsWith('worktree ')).length).toBe(1);
}

/** A run's working directory is one of Rigour's throwaway copies in the system's temporary directory. */
export const inCopy = (run: JudgeRun) => run.cwd.startsWith(fs.realpathSync(os.tmpdir())) && path.basename(run.cwd).startsWith('rigour-judge-copy-');

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
