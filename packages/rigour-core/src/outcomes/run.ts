/**
 * `rigour outcomes`: bring the outcome records of the repository's recent merged pull requests up to date (outcome.ts),
 * when the outcome loop is on (switches.ts). The pull requests are listed newest merge first, keyset by merge time; a
 * settled record costs nothing; the whole read stops at a deadline and says why.
 */
import type { Config } from '../types/index.js';
import { branchBase } from '../gates/logic-drift-git-base.js';
import { mergedPrs, type MergedPr } from '../review/backtest-init.js';
import { defaultExec, githubEnv, GH_TIMEOUT_MS, type Exec } from '../review/reviewer/exec.js';
import { resolveSwitch, type ResolvedSwitch } from '../switches.js';
import { checkRunsCi, updatePrOutcomes, type PrOutcome } from './outcome.js';

/** How long one run may read before it stops and keeps what it has. */
const READ_DEADLINE_MS = 2 * 60_000;

export interface OutcomesRun {
    switch: ResolvedSwitch;
    outcomes: PrOutcome[];
    /** Records read from git and GitHub this run (settled ones are not). */
    read: number;
    /** Why the run read less than it was asked to, when it did. */
    stopped?: string;
}

export async function runOutcomes(cwd: string, config: Config, options: { flag?: boolean; pr?: number; last?: number; exec?: Exec }): Promise<OutcomesRun> {
    const exec = options.exec ?? defaultExec;
    const resolved = resolveSwitch('outcomes', config, options.flag);
    if (!resolved.enabled) return { switch: resolved, outcomes: [], read: 0, stopped: 'the outcome loop is off: learning.outcomes.mode in rigour.yml, RIGOUR_OUTCOMES=on, or --outcomes' };
    const mainRef = branchBase(cwd)?.mainRef;
    if (!mainRef) return { switch: resolved, outcomes: [], read: 0, stopped: 'no main branch to read outcomes on' };
    const env = await githubEnv(cwd, config.review?.github_account ?? process.env.RIGOUR_GITHUB_ACCOUNT, exec);
    const listed = options.pr !== undefined ? await onePr(cwd, options.pr, exec, env) : await mergedPrs(cwd, options.last ?? 20, config, exec);
    const run = await updatePrOutcomes(cwd, listed.prs, {
        mainRef,
        windowDays: config.learning?.outcomes?.window_days ?? 30,
        ci: checkRunsCi(cwd, exec, env),
        deadline: Date.now() + READ_DEADLINE_MS,
    });
    const incomplete = listed.incomplete ? 'the list of merged pull requests may be incomplete (gh listed too many updates to prove it)' : undefined;
    const stopped = [run.stopped, incomplete].filter(Boolean).join('; ');
    return { switch: resolved, outcomes: run.outcomes, read: run.read, ...(stopped ? { stopped } : {}) };
}

async function onePr(cwd: string, pr: number, exec: Exec, env: Record<string, string> | undefined): Promise<{ prs: MergedPr[]; incomplete: boolean }> {
    const view = await exec('gh', ['pr', 'view', String(pr), '--json', 'number,mergedAt,mergeCommit,headRefName,state'], { cwd, timeoutMs: GH_TIMEOUT_MS, ...(env ? { env } : {}) });
    if (view.exitCode !== 0) throw new Error(`could not read pull request #${pr}: ${view.stderr.trim() || 'is gh signed in?'}`);
    const p = JSON.parse(view.stdout);
    if (p.state !== 'MERGED' || !p.mergeCommit?.oid) throw new Error(`pull request #${pr} is not merged`);
    return { prs: [{ number: p.number, mergedAt: p.mergedAt, mergeSha: p.mergeCommit.oid, branch: p.headRefName ?? '' }], incomplete: false };
}
