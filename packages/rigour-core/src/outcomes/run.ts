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
import { checkRunsCi, readPrOutcomes, updatePrOutcomes, type PrOutcome } from './outcome.js';
import { applyOutcomeEvidence, type OutcomeEvidenceResult } from '../review-learning/outcome-evidence.js';
import { readLessons, writeLessons } from '../review-learning/lessons.js';
import { gitIn } from '../review-learning/acted-on.js';
import { eventsOfKind } from '../task/thread.js';
import { outcomeMetrics, type OutcomeMetrics, type PrReviews } from './metrics.js';

/** How long one run may read before it stops and keeps what it has. */
const READ_DEADLINE_MS = 2 * 60_000;
/** How long one run may follow points' lines through history; the next run carries on. */
const LESSON_DEADLINE_MS = 60_000;

export interface OutcomesRun {
    switch: ResolvedSwitch;
    outcomes: PrOutcome[];
    /** Records read from git and GitHub this run (settled ones are not). */
    read: number;
    /** Why the run read less than it was asked to, when it did. */
    stopped?: string;
    /** What the records did to the team's review lessons (review-learning/outcome-evidence.ts). */
    lessons?: OutcomeEvidenceResult;
    /** The outcome numbers over every record kept (metrics.ts). */
    metrics?: OutcomeMetrics;
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
    const lessons = lessonEvidence(cwd, mainRef, config.learning?.outcomes?.demote_after ?? 2);
    const metrics = localOutcomeMetrics(cwd);
    return { switch: resolved, outcomes: run.outcomes, read: run.read, ...(lessons ? { lessons } : {}), ...(metrics ? { metrics } : {}), ...(stopped ? { stopped } : {}) };
}

/** Every record kept (not only this run's) against the team's lessons, and the reviews that found a lesson repeated; written only when something changed. */
function lessonEvidence(cwd: string, mainRef: string, demoteAfter: number): OutcomeEvidenceResult | undefined {
    const lessons = readLessons(cwd);
    if (lessons.length === 0) return undefined;
    const result = applyOutcomeEvidence(lessons, Object.values(readPrOutcomes(cwd).outcomes), threadReviews(cwd).applied, { demoteAfter, git: gitIn(cwd), mainRef, deadline: Date.now() + LESSON_DEADLINE_MS });
    if (result.added) writeLessons(cwd, lessons);
    return result;
}

/** Per pull request, the lessons a review of it recorded as applying, and every pull request a review by Rigour ran on with its rounds' dollars and its first review's findings: from the threads. */
export function threadReviews(cwd: string): { applied: Map<number, Set<string>>; reviewed: Map<number, PrReviews> } {
    const applied = new Map<number, Set<string>>();
    const reviewed = new Map<number, PrReviews>();
    const count = (v: unknown) => typeof v === 'number' ? v : 0;
    for (const e of eventsOfKind(cwd, 'review')) {
        if (typeof e.pr !== 'number') continue;
        const pr = reviewed.get(e.pr) ?? { usd: 0, earlierBasis: false };
        pr.usd += count(e.cost_usd);
        if (e.cost_basis !== 'runs') pr.earlierBasis = true;
        if (!pr.first && typeof e.checks === 'number') pr.first = { model: count(e.blocking) + count(e.should_fix), checks: e.checks };
        reviewed.set(e.pr, pr);
        if (!Array.isArray(e.lessons_applied)) continue;
        const ids = applied.get(e.pr) ?? new Set<string>();
        for (const id of e.lessons_applied) if (typeof id === 'string') ids.add(id);
        applied.set(e.pr, ids);
    }
    return { applied, reviewed };
}

/** The outcome numbers for this checkout (metrics.ts), over every record it keeps; undefined when it keeps none. Read-only. */
export function localOutcomeMetrics(cwd: string): OutcomeMetrics | undefined {
    const records = Object.values(readPrOutcomes(cwd).outcomes);
    return records.length ? outcomeMetrics(records, readLessons(cwd), threadReviews(cwd).reviewed) : undefined;
}

async function onePr(cwd: string, pr: number, exec: Exec, env: Record<string, string> | undefined): Promise<{ prs: MergedPr[]; incomplete: boolean }> {
    const view = await exec('gh', ['pr', 'view', String(pr), '--json', 'number,mergedAt,mergeCommit,headRefName,author,state'], { cwd, timeoutMs: GH_TIMEOUT_MS, ...(env ? { env } : {}) });
    if (view.exitCode !== 0) throw new Error(`could not read pull request #${pr}: ${view.stderr.trim() || 'is gh signed in?'}`);
    const p = JSON.parse(view.stdout);
    if (p.state !== 'MERGED' || !p.mergeCommit?.oid) throw new Error(`pull request #${pr} is not merged`);
    return { prs: [{ number: p.number, mergedAt: p.mergedAt, mergeSha: p.mergeCommit.oid, branch: p.headRefName ?? '', author: p.author?.login ?? '' }], incomplete: false };
}
