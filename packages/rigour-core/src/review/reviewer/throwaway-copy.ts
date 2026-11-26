/**
 * The throwaway copy a judge that runs code works in (run-code.ts): a standalone clone of the reviewed commit in the
 * system's temporary directory, sharing the person's objects (`--shared`, nothing copied) with no remote. Not a git
 * worktree: a worktree resolves to the person's checkout, so a CLI took that checkout's trust and wrote its own files
 * there (Claude Code's `.claude/.cc-writes`). Every copy is removed afterwards, and so is every process the judge
 * started (judge-processes.ts): after an answer, an error, a timeout, or a SIGINT or SIGTERM to Rigour itself. A copy
 * a killed process left behind is swept at the next run_code review, once it is older than the judge's timeout.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { GH_TIMEOUT_MS, type Exec } from './exec.js';
import { alive, endJudgeProcesses } from './judge-processes.js';
import { onTermination } from './on-termination.js';
import { shareDependencies } from './throwaway-worktree.js';

const COPY_PREFIX = 'rigour-judge-copy-';
const GIT_TIMEOUT_MS = 5 * GH_TIMEOUT_MS;

/** Ends the judge and what it started, then waits (at most two seconds) until the judge has exited. */
async function endJudge(pid: number | undefined, dir: string): Promise<void> {
    endJudgeProcesses(pid, dir);
    for (let i = 0; pid && i < 40 && alive(pid); i++) await new Promise(resolve => setTimeout(resolve, 50));
}

/** The person's object store, where a copy of this repository points its alternates. */
function objectsDir(cwd: string): string | undefined {
    const common = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, encoding: 'utf8' });
    return common.status === 0 ? fs.realpathSync(path.join(common.stdout.trim(), 'objects')) : undefined;
}

/**
 * Removes the copies of this repository a killed run left behind: named with Rigour's prefix, pointing at this
 * repository's objects, and older than `olderThanMs` (a copy a running review still uses is younger than its timeout).
 */
export function sweepStaleCopies(cwd: string, olderThanMs: number, now = Date.now()): string[] {
    const objects = objectsDir(cwd);
    if (!objects) return [];
    const swept: string[] = [];
    for (const name of fs.readdirSync(os.tmpdir()).filter(entry => entry.startsWith(COPY_PREFIX))) {
        const dir = path.join(os.tmpdir(), name);
        try {
            const alternates = fs.readFileSync(path.join(dir, '.git', 'objects', 'info', 'alternates'), 'utf8').trim();
            if (fs.realpathSync(alternates) !== objects || now - fs.statSync(dir).mtimeMs < olderThanMs) continue;
            fs.rmSync(dir, { recursive: true, force: true });
            swept.push(dir);
        } catch {
            // not a copy of this repository
        }
    }
    return swept;
}

/** A standalone copy of `head`, or why it could not be made. */
async function makeCopy(cwd: string, dir: string, head: string, exec: Exec): Promise<string | undefined> {
    const git = (args: string[], at = dir) => exec('git', args, { cwd: at, timeoutMs: GIT_TIMEOUT_MS });
    const steps: Array<() => ReturnType<Exec>> = [
        () => git(['clone', '--quiet', '--shared', '--no-checkout', cwd, dir], cwd),
        () => git(['checkout', '--quiet', '--detach', head]),
        () => git(['remote', 'remove', 'origin']),
    ];
    for (const step of steps) {
        const done = await step();
        if (done.exitCode !== 0) return done.stderr.trim() || `git exited ${done.exitCode}`;
    }
    shareDependencies(cwd, dir);
    return undefined;
}

/**
 * Runs `work` in a new copy of `head`, handing it a place to record the judge's pid; afterwards (an answer, an error,
 * a timeout, or Rigour interrupted) every process the judge started is ended, the copy removed, and `leftovers` told
 * the copy's path, to remove what a CLI kept under it elsewhere.
 */
export async function withThrowawayCopy<T>(cwd: string, head: string, exec: Exec, work: (dir: string, started: (pid: number) => void) => Promise<T>, leftovers: (dir: string) => void = () => undefined): Promise<T | { error: string }> {
    // The real path: what the system reports as a process's working directory inside the copy (judge-processes.ts).
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), COPY_PREFIX)));
    let pid: number | undefined;
    const remove = () => {
        fs.rmSync(dir, { recursive: true, force: true });
        leftovers(dir);
    };
    const unregister = onTermination(() => {
        endJudgeProcesses(pid, dir);
        remove();
    });
    try {
        const failed = await makeCopy(cwd, dir, head, exec);
        if (failed) return { error: `could not make a throwaway copy of ${head.slice(0, 9)}: ${failed}` };
        return await work(dir, started => { pid = started; });
    } finally {
        await endJudge(pid, dir);
        remove();
        unregister();
    }
}
