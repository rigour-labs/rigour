/**
 * What happened after a pull request merged: the CI result on its merge commit, the later commits on main that touched
 * its files within the window, and whether it was reverted. One record per merge commit, computed from git and one
 * GitHub read, and kept in `.rigour/outcomes.json`. Once the window has closed and CI has an answer, the record is
 * settled: it never changes and is never read from GitHub again.
 *
 * Follow-ups are read on main's first-parent history, by file, so a merge commit and a squash merge are read the same
 * way. Nothing here changes a lesson: lessons read these records as evidence (review-learning).
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { FIX, revertsPr } from '../review-learning/outcomes.js';
import { GH_TIMEOUT_MS, type Exec } from '../review/reviewer/exec.js';
import { appendBranchEvent } from '../task/thread.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const OUTCOMES_FILE = path.join('.rigour', 'outcomes.json');

/** success and failure from the check runs; pending while one runs; none when there are none; unavailable when GitHub could not say. */
export type CiResult = 'success' | 'failure' | 'pending' | 'none' | 'unavailable';

export interface FollowUp {
    sha: string;
    at: string;
    subject: string;
    /** The pull request's files this commit touched. */
    files: string[];
    /** Its subject says it fixed something (the same words review-learning reads). */
    fix: boolean;
}

export interface PrOutcome {
    pr: number;
    mergeSha: string;
    mergedAt: string;
    branch: string;
    /** What the merge changed on main: its first-parent diff. */
    files: string[];
    ci: CiResult;
    followUps: FollowUp[];
    /** The commit that reverted it, when one did. */
    reverted?: { sha: string; subject: string };
    /** The end of the window: later commits count up to here. */
    windowEnd: string;
    /** The window has closed and CI has an answer: the record never changes again. */
    settled: boolean;
    checkedAt: string;
}

export interface OutcomeOptions {
    mainRef: string;
    windowDays: number;
    /** Only history before this time (a backtest); now when unset. */
    until?: string;
    /** The CI result for a commit (gh); `unavailable` when it cannot be read. */
    ci: (sha: string) => Promise<CiResult>;
}

/** The outcome of one merged pull request as of now (or `until`). */
async function prOutcome(cwd: string, pr: { number: number; mergeSha: string; mergedAt: string; branch: string }, options: OutcomeOptions): Promise<PrOutcome> {
    const now = options.until ? Date.parse(options.until) : Date.now();
    const windowEnd = new Date(Math.min(Date.parse(pr.mergedAt) + options.windowDays * DAY_MS, now)).toISOString();
    const closed = Date.parse(pr.mergedAt) + options.windowDays * DAY_MS <= now;
    const files = lines(git(cwd, ['diff', '--name-only', `${pr.mergeSha}^1`, pr.mergeSha]));
    const followUps = files.length ? followUpsOf(cwd, pr.mergeSha, options.mainRef, files, pr.mergedAt, windowEnd) : [];
    const revert = followUps.find(f => revertsPr(f.subject, pr));
    const ci = await options.ci(pr.mergeSha);
    return {
        pr: pr.number, mergeSha: pr.mergeSha, mergedAt: pr.mergedAt, branch: pr.branch, files, ci, followUps,
        ...(revert ? { reverted: { sha: revert.sha, subject: revert.subject } } : {}),
        windowEnd,
        settled: closed && (ci === 'success' || ci === 'failure' || ci === 'none'),
        checkedAt: new Date(now).toISOString(),
    };
}

/** First-parent commits on main after the merge, inside the window, that touched any of the pull request's files. Both ends bounded. */
function followUpsOf(cwd: string, mergeSha: string, mainRef: string, files: string[], from: string, to: string): FollowUp[] {
    const wanted = new Set(files);
    const out = git(cwd, ['log', '--first-parent', '--name-only', '--format=%x00%H%x09%cI%x09%s', `--since=${from}`, `--until=${to}`, `${mergeSha}..${mainRef}`, '--', ...files]);
    return out.split('\0').filter(Boolean).flatMap(block => {
        const [header, ...rest] = block.split('\n');
        const [sha, at, ...subject] = header.split('\t');
        if (!sha || !at) return [];
        const touched = rest.map(line => line.trim()).filter(file => wanted.has(file));
        const text = subject.join('\t');
        return [{ sha, at, subject: text, files: touched, fix: FIX.test(text) }];
    }).reverse(); // oldest first
}

/** The CI result for a commit from its check runs, with one `gh api` call; any error is `unavailable`, never a throw. */
export function checkRunsCi(cwd: string, exec: Exec, env?: Record<string, string>): (sha: string) => Promise<CiResult> {
    return async sha => {
        try {
            const read = await exec('gh', ['api', `repos/{owner}/{repo}/commits/${sha}/check-runs?per_page=100`, '--jq', '[.check_runs[] | {status, conclusion}]'], { cwd, timeoutMs: GH_TIMEOUT_MS, ...(env ? { env } : {}) });
            if (read.exitCode !== 0) return 'unavailable';
            return ciFrom(JSON.parse(read.stdout));
        } catch {
            return 'unavailable';
        }
    };
}

/** A failure anywhere fails it; a run still going keeps it pending; cancelled and skipped runs say nothing. */
function ciFrom(runs: Array<{ status?: string; conclusion?: string | null }>): CiResult {
    if (!Array.isArray(runs) || runs.length === 0) return 'none';
    if (runs.some(r => r.conclusion === 'failure' || r.conclusion === 'timed_out')) return 'failure';
    if (runs.some(r => r.status !== 'completed')) return 'pending';
    return runs.some(r => r.conclusion === 'success') ? 'success' : 'none';
}

interface OutcomeStore { version: 1; outcomes: Record<string, PrOutcome> }

function readPrOutcomes(cwd: string): OutcomeStore {
    try {
        const parsed = JSON.parse(fs.readFileSync(path.join(cwd, OUTCOMES_FILE), 'utf8'));
        return parsed?.version === 1 && parsed.outcomes && typeof parsed.outcomes === 'object' ? parsed : { version: 1, outcomes: {} };
    } catch {
        return { version: 1, outcomes: {} };
    }
}

/**
 * Brings the store up to date for these merged pull requests: a settled record is kept as it is, anything else is read
 * again. The branch's thread (when this machine has one) gets a `merge` event the first time and an `outcome` event when
 * the record settles. Stops at `deadline` (ms since epoch) and says so: what was read is kept.
 */
export async function updatePrOutcomes(cwd: string, prs: Array<{ number: number; mergeSha: string; mergedAt: string; branch: string }>, options: OutcomeOptions & { deadline?: number }): Promise<{ outcomes: PrOutcome[]; read: number; stopped?: string }> {
    const store = readPrOutcomes(cwd);
    const result: PrOutcome[] = [];
    let read = 0;
    let stopped: string | undefined;
    for (const pr of prs) {
        if (!pr.mergeSha) continue;
        const known = store.outcomes[pr.mergeSha];
        if (known?.settled) {
            result.push(known);
            continue;
        }
        if (options.deadline !== undefined && Date.now() > options.deadline) {
            stopped = `read deadline reached after ${read} pull request(s); run again to read the rest`;
            break;
        }
        const outcome = await prOutcome(cwd, pr, options);
        read++;
        if (!known) appendBranchEvent(cwd, pr.branch, { kind: 'merge', pr: pr.number, merge_sha: pr.mergeSha, merged_at: pr.mergedAt });
        if (outcome.settled) appendBranchEvent(cwd, pr.branch, { kind: 'outcome', pr: pr.number, ci: outcome.ci, follow_ups: outcome.followUps.length, fixes: outcome.followUps.filter(f => f.fix).length, reverted: !!outcome.reverted });
        store.outcomes[pr.mergeSha] = outcome;
        result.push(outcome);
    }
    fs.mkdirSync(path.join(cwd, '.rigour'), { recursive: true });
    fs.writeFileSync(path.join(cwd, OUTCOMES_FILE), JSON.stringify(store, null, 2) + '\n');
    return { outcomes: result, read, ...(stopped ? { stopped } : {}) };
}

function git(cwd: string, args: string[]): string {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 60_000 });
    return result.status === 0 ? result.stdout : '';
}

function lines(text: string): string[] {
    return text.split('\n').map(line => line.trim()).filter(Boolean);
}
