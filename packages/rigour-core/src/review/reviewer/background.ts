/**
 * The model review that does not hold the push. Once the deterministic gates pass, the pushed
 * commit is reviewed in a detached worktree of that exact commit (later commits or edits cannot
 * change what it reads), in its own process group, so the push returns in seconds. A newer push
 * of the same branch ends a review still running for an older commit. The verdict goes to the
 * store (shared by the worktree, the checkout and the status command), a desktop notification
 * and `rigour review --status`. The hard stop stays explicit: `rigour review --reviewer --full`
 * before asking a person to look.
 */
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import type { Config } from '../../types/index.js';
import { runReviewer, type ReviewerResult } from '../reviewer.js';
import { defaultExec, GH_TIMEOUT_MS, type Exec } from './exec.js';
import { VerdictStore } from './store.js';
import { itemLine, type OpenItem } from './verdict.js';

export interface BackgroundJob { head: string; branch: string; base: string }

/**
 * Starts `command` detached (its own process group, output to the branch's log) and records its
 * pid; a job still running for the same branch is ended first. Returns the log path.
 */
export async function startBackgroundReview(cwd: string, job: BackgroundJob, command: string[], exec: Exec = defaultExec): Promise<string | undefined> {
    const store = await VerdictStore.open(cwd, exec);
    if (!store) return undefined;
    endRunning(store, job.branch);
    const log = store.branchFile(job.branch, 'log');
    const out = fs.openSync(log, 'w');
    const child = spawn(command[0], command.slice(1), { cwd, detached: true, stdio: ['ignore', out, out], env: process.env });
    fs.closeSync(out);
    if (child.pid) fs.writeFileSync(store.branchFile(job.branch, 'pid'), `${child.pid} ${job.head}\n`);
    child.unref();
    return log;
}

/** The detached process: review the commit in a worktree of its own, write the verdict, tell the person. */
export async function backgroundReview(cwd: string, job: BackgroundJob, config: Config, exec: Exec = defaultExec, log: (line: string) => void = line => process.stdout.write(`${line}\n`)): Promise<ReviewerResult> {
    const store = await VerdictStore.open(cwd, exec);
    if (!store) throw new Error(`${cwd} is not a repository`);
    const worktree = store.worktreeDir(job.head);
    const added = await exec('git', ['worktree', 'add', '--detach', worktree, job.head], { cwd, timeoutMs: 5 * GH_TIMEOUT_MS });
    if (added.exitCode !== 0 && !fs.existsSync(path.join(worktree, '.git'))) throw new Error(`could not check out ${job.head.slice(0, 9)} for the review: ${added.stderr.trim()}`);
    try {
        const result = await runReviewer(worktree, job.base, config, exec, log, { trigger: 'push', branch: job.branch });
        log(`review of ${job.head.slice(0, 9)}: ${result.outcome}${result.reason ? ` (${result.reason})` : ''}${result.items.length ? `, ${result.items.length} open item(s)` : ''}`);
        for (const item of result.items) log(`  ${itemLine(item)}`);
        notify(`Rigour review of ${job.branch} @ ${job.head.slice(0, 9)}: ${result.outcome}${result.items.length ? `, ${result.items.length} open item(s)` : ''}`);
        return result;
    } finally {
        await exec('git', ['worktree', 'remove', '--force', worktree], { cwd, timeoutMs: 5 * GH_TIMEOUT_MS });
        const pidFile = store.branchFile(job.branch, 'pid');
        if (fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').startsWith(`${process.pid} `)) fs.unlinkSync(pidFile);
    }
}

export interface ReviewStatus {
    branch: string;
    /** A review still running, and for which commit. */
    running?: { pid: number; head: string };
    /** The last verdict recorded for the branch. */
    last?: { head: string; mode: 'full' | 'delta'; at: string; open: OpenItem[] };
    log?: string;
}

/** What the background reviewer has done for a branch: running, the last verdict and its open items. */
export async function reviewStatus(cwd: string, branch: string, exec: Exec = defaultExec): Promise<ReviewStatus | undefined> {
    const store = await VerdictStore.open(cwd, exec);
    if (!store) return undefined;
    const status: ReviewStatus = { branch };
    const running = runningJob(store, branch);
    if (running) status.running = running;
    const state = store.branchState(branch);
    if (state) status.last = { head: state.head, mode: state.mode, at: state.at, open: store.readJson<OpenItem[]>(store.openPath(state.verdict)) ?? [] };
    const log = store.branchFile(branch, 'log');
    if (fs.existsSync(log)) status.log = log;
    return status;
}

function runningJob(store: VerdictStore, branch: string): { pid: number; head: string } | undefined {
    const pidFile = store.branchFile(branch, 'pid');
    if (!fs.existsSync(pidFile)) return undefined;
    const [pid, head] = fs.readFileSync(pidFile, 'utf8').trim().split(' ');
    if (!alive(Number(pid))) {
        fs.unlinkSync(pidFile);
        return undefined;
    }
    return { pid: Number(pid), head: head ?? '' };
}

/** Ends a review still running for the branch (the whole process group: the CLI and the agent it runs). */
function endRunning(store: VerdictStore, branch: string): void {
    const running = runningJob(store, branch);
    if (!running) return;
    try {
        process.kill(process.platform === 'win32' ? running.pid : -running.pid, 'SIGTERM');
    } catch {
        // already gone
    }
    fs.unlinkSync(store.branchFile(branch, 'pid'));
}

function alive(pid: number): boolean {
    if (!pid) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

/** A desktop notification where the platform has one; silence otherwise. */
function notify(message: string): void {
    const safe = message.replace(/["\\]/g, '');
    if (process.platform === 'darwin') spawnSync('osascript', ['-e', `display notification "${safe}" with title "Rigour"`], { stdio: 'ignore', timeout: 5000 });
    else if (process.platform === 'linux') spawnSync('notify-send', ['Rigour', safe], { stdio: 'ignore', timeout: 5000 });
}
