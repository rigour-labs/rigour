/**
 * A detached git worktree of one commit, made to be thrown away: the background review reads a pushed commit in one
 * (background.ts). Removal is forced (untracked files go with it). A judge that runs code gets a standalone copy
 * instead (throwaway-copy.ts): a worktree resolves to the person's checkout, whose trust and settings it would share.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { GH_TIMEOUT_MS, type Exec } from './exec.js';
import { onTermination } from './on-termination.js';

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

/** Removes the worktree if Rigour is interrupted before the returned function is called (which unregisters it). */
export function removeWorktreeOnTermination(cwd: string, dir: string): () => void {
    return onTermination(() => { spawnSync('git', ['worktree', 'remove', '--force', dir], { cwd, stdio: 'ignore' }); });
}

/** The checkout's installed dependencies serve the worktree too (a compiler, a test runner), never a download. */
export function shareDependencies(cwd: string, worktree: string): void {
    const root = path.join(cwd, 'node_modules');
    if (fs.existsSync(root) && !fs.existsSync(path.join(worktree, 'node_modules'))) fs.symlinkSync(root, path.join(worktree, 'node_modules'), 'junction');
}
