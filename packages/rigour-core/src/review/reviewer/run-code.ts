/**
 * review.reviewer.run_code: a judge may write and run scratch code to confirm a problem. Off by default. When on, a judge
 * whose sandbox was verified (adapters.ts runCodeRefusal) runs in a throwaway worktree of the reviewed commit, sandboxed,
 * with no network and no secret-looking variable, and its working copy is never evidence: quotes are still checked
 * against the person's checkout. Refused, and said, where the change's code must not run on the reviewer's say-so: CI,
 * an independent review, a backtest replay. Running code costs more tokens and time; the caps apply as to any run.
 */
import { ADAPTERS, type ReviewerName } from './adapters.js';
import type { Exec } from './exec.js';
import { secretVariables } from './judge-env.js';
import { withRunCode } from './prompt.js';
import { withThrowawayWorktree } from './throwaway-worktree.js';

export interface RunCodeContext { ci: boolean; independent: boolean; backtest: boolean }

/** Whether this run is CI: the --ci flag, or the variables CI services set. */
export function isCi(flag: boolean | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
    const set = (value: string | undefined) => !!value && !/^(0|false|no)$/i.test(value.trim());
    return !!flag || set(env.CI) || set(env.GITHUB_ACTIONS);
}

/** Whether any judge may run code on this run, and the line that says why not when the team turned it on. */
export function runCodeAllowed(setting: 'off' | 'on', context: RunCodeContext): { on: boolean; refused?: string } {
    if (setting !== 'on') return { on: false };
    const why = context.ci ? 'this is CI (CI, GITHUB_ACTIONS or --ci)'
        : context.independent ? 'an independent review runs none of the change\'s code'
            : context.backtest ? 'a backtest replays reviews read-only' : undefined;
    return why ? { on: false, refused: `run_code refused: ${why}; every judge stays read-only` } : { on: true };
}

/** Why `name` stays read-only although run_code is on, or undefined when it runs code. */
export function judgeRunCodeRefusal(name: ReviewerName, version: string | undefined): string | undefined {
    const why = ADAPTERS[name].runCodeRefusal(version);
    return why ? `run_code: ${why}; ${name} stays read-only` : undefined;
}

/** How a judge that ran code is named in the output and the record. */
export function ranCodeLabel(name: string): string {
    return name === 'claude' ? `${name} (ran code in a sandboxed throwaway copy)` : `${name} (ran code in a throwaway copy)`;
}

export interface CodeRun { binary: string; name: ReviewerName; version: string; prompt: string; model: string | undefined; reasoning?: 'low' | 'medium' | 'high'; timeoutMs: number; unset: string[]; env?: Record<string, string> }

/**
 * One judge run that may run code: in a throwaway worktree of `head` (removed afterwards, on a timeout too), told so
 * in its prompt, with secret-looking variables removed. A copy that cannot be made is a failed run, said as one.
 */
export async function runInThrowawayCopy(cwd: string, head: string, exec: Exec, run: CodeRun): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const unset = [...new Set([...run.unset, ...secretVariables()])];
    const result = await withThrowawayWorktree(cwd, head, exec, dir => exec(run.binary, ADAPTERS[run.name].args(withRunCode(run.prompt, dir), run.model, { reasoning: run.reasoning, version: run.version, runCode: true }), { cwd: dir, timeoutMs: run.timeoutMs, unset, ...(run.env ? { env: run.env } : {}) }));
    return 'error' in result ? { exitCode: 1, stdout: '', stderr: result.error } : result;
}
