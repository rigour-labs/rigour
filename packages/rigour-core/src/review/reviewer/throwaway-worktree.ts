/**
 * A detached git worktree of one commit, made to be thrown away: the background review reads a pushed commit in one
 * (background.ts), and a judge that runs code works in one of its own (run-code.ts), so nothing it writes reaches the
 * person's checkout. Removal is forced (untracked scratch files go with it) and pruned, whatever the run did.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { GH_TIMEOUT_MS, type Exec } from './exec.js';

const WORKTREE_TIMEOUT_MS = 5 * GH_TIMEOUT_MS;

/** Checks out `head` detached at `dir`; the error when git could not and left no checkout there. */
export async function addDetachedWorktree(cwd: string, dir: string, head: string, exec: Exec): Promise<string | undefined> {
    const added = await exec('git', ['worktree', 'add', '--detach', dir, head], { cwd, timeoutMs: WORKTREE_TIMEOUT_MS });
    if (added.exitCode !== 0 && !fs.existsSync(path.join(dir, '.git'))) return added.stderr.trim() || `git worktree add exited ${added.exitCode}`;
    return undefined;
}

/** Removes the worktree, its untracked files included. */
export async function removeWorktree(cwd: string, dir: string, exec: Exec): Promise<void> {
    await exec('git', ['worktree', 'remove', '--force', dir], { cwd, timeoutMs: WORKTREE_TIMEOUT_MS });
}

/** The checkout's installed dependencies serve the worktree too (a compiler, a test runner), never a download. */
export function shareDependencies(cwd: string, worktree: string): void {
    const root = path.join(cwd, 'node_modules');
    if (fs.existsSync(root) && !fs.existsSync(path.join(worktree, 'node_modules'))) fs.symlinkSync(root, path.join(worktree, 'node_modules'), 'junction');
}

/**
 * Runs `work` in a new worktree of `head` under the system's temporary directory, outside the repository, and removes
 * it afterwards: after an answer, an error or a timeout alike.
 */
export async function withThrowawayWorktree<T>(cwd: string, head: string, exec: Exec, work: (dir: string) => Promise<T>): Promise<T | { error: string }> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rigour-judge-copy-'));
    try {
        const failed = await addDetachedWorktree(cwd, dir, head, exec);
        if (failed) return { error: `could not make a throwaway copy of ${head.slice(0, 9)}: ${failed}` };
        shareDependencies(cwd, dir);
        return await work(dir);
    } finally {
        await removeWorktree(cwd, dir, exec);
        fs.rmSync(dir, { recursive: true, force: true });
        await exec('git', ['worktree', 'prune'], { cwd, timeoutMs: WORKTREE_TIMEOUT_MS });
    }
}
