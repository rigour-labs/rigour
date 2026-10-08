/**
 * The goal at the stop hook and the push gate: the description of the branch's open pull request, read with one `gh`
 * call, cached per branch and HEAD, and skipped silently when there is none or gh cannot answer. Only the deterministic
 * checks run there (goal/goal.ts): no model at a stop or a push. The same switch and floor as `rigour review --goal`.
 */
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import type { Config } from '../types/index.js';
import type { ReviewResult } from '../review/review.js';
import { defaultExec, type Exec } from '../review/reviewer/exec.js';
import { appendTaskEvent, threadsDir } from '../task/thread.js';
import { resolveGoal } from './settings.js';

/** A stop or a push waits at most this long for GitHub, per call: the goal is worth a check, not a stall. */
const HOOK_GH_TIMEOUT_MS = 5_000;

type Cache = Record<string, { head: string; body: string | null }>;

/** The open pull request's description for this branch, when the goal check is on; undefined otherwise or when it cannot be read. */
export async function hookGoalDescription(cwd: string, config: Config, exec: Exec = defaultExec): Promise<string | undefined> {
    if (!resolveGoal(config).enabled) return undefined;
    const branch = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const head = git(cwd, ['rev-parse', 'HEAD']);
    const dir = threadsDir(cwd);
    if (!branch || branch === 'HEAD' || !head || !dir) return undefined;
    const file = path.join(path.dirname(dir), 'goal-cache.json');
    const cache = readCache(file);
    if (cache[branch]?.head === head) return cache[branch].body ?? undefined;
    const body = await openDescription(cwd, branch, config, exec);
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ ...cache, [branch]: { head, body: body ?? null } }));
    } catch {
        // a cache that cannot be written costs one more gh call next time, never the check
    }
    return body;
}

/** Records on the task's thread what the goal check did at a stop or a push; nothing when it had no description to check. */
export function recordGoal(cwd: string, moment: 'stop' | 'push', description: string | undefined, result: Pick<ReviewResult, 'goal' | 'findings'>): void {
    if (description === undefined) return;
    appendTaskEvent(cwd, { kind: 'goal', moment, declared: !!result.goal, blocks: result.findings.filter(f => f.id.startsWith('goal-')).length });
}

async function openDescription(cwd: string, branch: string, config: Config, exec: Exec): Promise<string | undefined> {
    try {
        const account = config.review?.github_account ?? process.env.RIGOUR_GITHUB_ACCOUNT;
        let env: Record<string, string> | undefined;
        if (account && !process.env.GH_TOKEN) {
            const token = await exec('gh', ['auth', 'token', '--user', account], { cwd, timeoutMs: HOOK_GH_TIMEOUT_MS });
            if (token.exitCode !== 0 || !token.stdout.trim()) return undefined;
            env = { GH_TOKEN: token.stdout.trim() };
        }
        const view = await exec('gh', ['pr', 'view', branch, '--json', 'state,body'], { cwd, timeoutMs: HOOK_GH_TIMEOUT_MS, ...(env ? { env } : {}) });
        if (view.exitCode !== 0) return undefined;
        const pr = JSON.parse(view.stdout);
        return pr?.state === 'OPEN' && typeof pr.body === 'string' ? pr.body : undefined;
    } catch {
        return undefined;
    }
}

function readCache(file: string): Cache {
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

function git(cwd: string, args: string[]): string | undefined {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 5_000 });
    return result.status === 0 ? result.stdout.trim() : undefined;
}
