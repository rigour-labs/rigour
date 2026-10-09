/**
 * The review orchestrator (opt-in, experimental): a router, not a fan-out. Triage (triage.ts) picks, without a model,
 * which of a fixed set of specialists a change needs, hunk by hunk; they run as ONE combined pass at every size, split
 * only when one pass would not fit the judge. The prompt and its input files are built once for the review; a pass adds
 * only its focus block and its slice of the diff. Verdicts merge through the reviewer's own accounting, so the evidence
 * contract, the quote check and what blocks are unchanged; an item two passes both raise is one item naming both.
 *
 * Fails safe: a pass with no verdict names its specialists as not reviewed, never "passed". With at least half of the
 * picked specialists back the result stands; with fewer, the caller falls back to one judge if the caps allow it, else
 * the review is unavailable. A change with nothing for a model to review gets no pass.
 */
import { createHash } from 'crypto';
import { CLEANUP_V1 } from './specialists/cleanup.v1.js';
import { CORRECTNESS_V1 } from './specialists/correctness.v1.js';
import { PRIOR_POINTS_V1 } from './specialists/prior-points.v1.js';
import { PRODUCTION_COST_V1 } from './specialists/production-cost.v1.js';
import { RULES_AND_GOAL_V1 } from './specialists/rules-and-goal.v1.js';
import type { Verdict } from './verdict.js';

export interface Specialist { id: string; version: number; title: string; steps: number[]; classes: string[]; focus: string }

/** The set is fixed in v1: not configurable, so a backtest and a measurement can pin it. */
export const SPECIALISTS: readonly Specialist[] = [PRIOR_POINTS_V1, CORRECTNESS_V1, PRODUCTION_COST_V1, CLEANUP_V1, RULES_AND_GOAL_V1];

/** What changes the orchestrated prompt: part of the verdict's fingerprint, so a single review's verdict is never reused for it. */
export const SPECIALISTS_KEY = createHash('sha256').update(JSON.stringify(SPECIALISTS)).digest('hex').slice(0, 12);

/** The block a pass's prompt ends with: its parts of the review and its slice of the diff; the rest is not its to report. */
export function focusBlock(parts: Specialist[], sliceFile: string): string {
    const steps = [...new Set(parts.flatMap(p => p.steps))].sort((a, b) => a - b);
    const classes = [...new Set(parts.flatMap(p => p.classes))];
    const priorPoints = parts.some(p => p.id === 'prior-points');
    return `

This review is split by part, and you do these: ${parts.map(p => p.title).join('; ')}. Your part of the diff is in
${sliceFile} (the hunks for these parts, and the hunks defining what they use); read the full diff only where a line of
yours needs it. Do step(s) ${steps.join(', ')} above, fully.${classes.length ? ` Report findings only of class ${classes.join(', ')}.` : ''}${priorPoints ? '' : ' Leave prior_points empty.'}
${parts.map(p => p.focus).join(' ')} Leave every list in the JSON that is not your part empty ([]).`;
}

export interface OrchestratedRun {
    /** The passes' verdicts that came back, each tagged `<judge>:<specialist,specialist>`. */
    parts: Verdict[];
    /** The picked specialists whose pass returned, and those whose pass did not. */
    returned: string[];
    missing: string[];
    /** At least half of the picked specialists returned: the result stands, partial when some are missing. */
    stands: boolean;
}

/** Runs every planned pass at once through `ask` (one judge run each, counted by the caller) and keeps what came back. */
export async function runPasses<P extends { specialists: string[] }>(judge: string, passes: P[], ask: (pass: P) => Promise<{ verdict: Verdict } | { error: string }>): Promise<OrchestratedRun> {
    const answers = await Promise.all(passes.map(async pass => ({ pass, answer: await ask(pass) })));
    const parts: Verdict[] = [];
    const returned: string[] = [];
    const missing: string[] = [];
    for (const { pass, answer } of answers) {
        if ('verdict' in answer) {
            parts.push({ ...answer.verdict, reviewer: `${judge}:${pass.specialists.join(',')}` });
            returned.push(...pass.specialists);
        } else missing.push(...pass.specialists);
    }
    return { parts, returned, missing, stands: returned.length * 2 >= returned.length + missing.length };
}

/** How many recent reviews of each kind the cost guard compares. */
const GUARD_WINDOW = 20;

/**
 * The cost guard: whether this review must stay one combined pass. The baseline is what one judge cost per changed line
 * in this repository's recent single reviews (kept in the verdict store from before the orchestrator was on). Without
 * that history the allowance is one run per review: one pass. Recent orchestrated reviews costing more per changed line
 * than the baseline: one pass. A split is only ever a capability for a change one pass cannot hold, never a default.
 */
export function costGuard(costs: Array<{ mode: 'single' | 'orchestrator'; lines: number; usd: number }>): { combinedOnly: boolean; why: string } {
    const singles = costs.filter(c => c.mode === 'single' && c.lines > 0 && c.usd > 0).slice(-GUARD_WINDOW);
    if (singles.length === 0) return { combinedOnly: true, why: 'no single-review cost in this repository yet: one run per review' };
    const perLine = singles.map(c => c.usd / c.lines).sort((a, b) => a - b);
    const baseline = perLine[Math.floor(perLine.length / 2)];
    const orchestrated = costs.filter(c => c.mode === 'orchestrator' && c.lines > 0).slice(-GUARD_WINDOW);
    const lines = orchestrated.reduce((sum, c) => sum + c.lines, 0);
    const spent = orchestrated.reduce((sum, c) => sum + c.usd, 0);
    if (lines > 0 && spent / lines > baseline) {
        return { combinedOnly: true, why: `orchestrated reviews cost $${(spent / lines).toFixed(4)} per changed line, one judge $${baseline.toFixed(4)}: one pass` };
    }
    return { combinedOnly: false, why: `within the single-review baseline ($${baseline.toFixed(4)} per changed line)` };
}
