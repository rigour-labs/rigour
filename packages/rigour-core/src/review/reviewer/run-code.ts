/**
 * review.reviewer.run_code: a judge may write and run scratch code to confirm a problem. Off by default. When on, a judge
 * whose sandbox was verified (judge-sandbox.ts) runs in a throwaway copy of the reviewed commit (throwaway-copy.ts),
 * sandboxed, with no network, no secret-looking variable and no git credential helper, in a process group of its own
 * that is ended afterwards, and its working copy is never evidence: quotes are still checked against the person's checkout. Refused, and said, where the change's code must not run on the reviewer's say-so: CI,
 * an independent review, a backtest replay. Running code costs more tokens and time; the caps apply as to any run.
 */
import { ADAPTERS, type ReviewerName } from './adapters.js';
import { CI_MARKERS } from '../../telemetry/telemetry.js';
import type { Exec } from './exec.js';
import { GIT_WITHOUT_CREDENTIALS, secretVariables } from './judge-env.js';
import { withRunCode } from './prompt.js';
import { withThrowawayCopy } from './throwaway-copy.js';

export interface RunCodeContext { ci: boolean; independent: boolean; backtest: boolean }

/** Whether this run is CI: the --ci flag, or a variable a CI service sets (telemetry's list: Jenkins, Azure, TeamCity…). */
export function isCi(flag: boolean | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
    const set = (value: string | undefined) => !!value && !/^(0|false|no)$/i.test(value.trim());
    return !!flag || CI_MARKERS.some(name => set(env[name]));
}

/** Whether any judge may run code on this run, and the line that says why not when the team turned it on. */
export function runCodeAllowed(setting: 'off' | 'on', context: RunCodeContext): { on: boolean; refused?: string } {
    if (setting !== 'on') return { on: false };
    const why = context.ci ? 'this is CI (a CI variable such as CI or GITHUB_ACTIONS, or --ci)'
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

/** The variables a judge that runs code runs without: what run-code removes on top of the judge's own unset list. */
export function runCodeUnset(name: ReviewerName, unset: string[]): string[] {
    return [...new Set([...unset, ...secretVariables(name)])];
}

/**
 * One judge run that may run code: in a throwaway copy of `head`, told so in its prompt, without secret-looking
 * variables or git credentials, in a process group of its own. The group is ended and the copy removed afterwards (a
 * timeout and SIGINT or SIGTERM included). A copy that cannot be made is a failed run, said as one.
 */
export async function runInThrowawayCopy(cwd: string, head: string, exec: Exec, run: CodeRun): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const result = await withThrowawayCopy(cwd, head, exec, (dir, started) => exec(run.binary, ADAPTERS[run.name].args(withRunCode(run.prompt, dir), run.model, { reasoning: run.reasoning, version: run.version, runCode: true }), {
        cwd: dir, timeoutMs: run.timeoutMs, unset: runCodeUnset(run.name, run.unset), env: { ...run.env, ...GIT_WITHOUT_CREDENTIALS }, detached: true, onSpawn: started,
    }));
    return 'error' in result ? { exitCode: 1, stdout: '', stderr: result.error } : result;
}
