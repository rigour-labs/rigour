/**
 * The review orchestrator (opt-in, experimental): a router, not a fan-out. Triage (triage.ts) picks, without a model,
 * which of a fixed set of specialists a change needs, hunk by hunk; they run as ONE combined pass at every size, split
 * only when one pass would not fit the judge. The prompt and its input files are built once for the review; a pass adds
 * only its focus block and its slice of the diff. Verdicts merge through the reviewer's own accounting, so the evidence
 * contract, the quote check and what blocks are unchanged; an item two passes both raise is one item naming both.
 *
 * Fails safe: a pass with no verdict is named as not reviewed, never "passed". With at least half of the passes back
 * the result stands; with fewer, the caller falls back to one judge, once, if the caps allow it, else the review is
 * unavailable. A change with nothing for a model to review gets no pass.
 *
 * Cost: a split always costs more than one pass for that review (each pass re-reads the shared inputs), so a split
 * spends only what the router already saved. The savings ledger is, over the last LEDGER_WINDOW orchestrated reviews,
 * what one judge would have been given minus what every run was given. A change over the judge's limit is split by
 * hunk only when the ledger covers the split's extra; an empty ledger (no history) never splits.
 */
import { createHash } from 'crypto';
import type { ReviewerName } from './adapters.js';
import type { CostBaseline, ReviewCost } from './store.js';
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
    /** The passes that returned and those that did not, by label (`correctness, cleanup`, or `part 2: correctness`). */
    returned: string[];
    missing: string[];
    /** At least half of the passes returned: the result stands, partial when some are missing. */
    stands: boolean;
}

/** A pass's name in the record: its specialists, and its part when the change was split. */
function passLabel(specialists: string[], index: number, of: number): string {
    return of > 1 ? `part ${index + 1}: ${specialists.join(', ')}` : specialists.join(', ');
}

/** Runs every planned pass at once through `ask` (one judge run each, counted by the caller) and keeps what came back. */
export async function runPasses<P extends { specialists: string[] }>(judge: string, passes: P[], ask: (pass: P) => Promise<{ verdict: Verdict } | { error: string }>): Promise<OrchestratedRun> {
    const answers = await Promise.all(passes.map(async pass => ({ pass, answer: await ask(pass) })));
    const parts: Verdict[] = [];
    const returned: string[] = [];
    const missing: string[] = [];
    answers.forEach(({ pass, answer }, i) => {
        const label = passLabel(pass.specialists, i, passes.length);
        if ('verdict' in answer) {
            parts.push({ ...answer.verdict, reviewer: `${judge}:${pass.specialists.join(',')}` });
            returned.push(label);
        } else missing.push(label);
    });
    return { parts, returned, missing, stands: returned.length * 2 >= passes.length };
}

/** How many recent orchestrated reviews the savings ledger sums: older savings never fund a split. */
const LEDGER_WINDOW = 20;
/** Single reviews the frozen baseline needs before it prices a character in dollars; with fewer, the ledger counts characters. */
export const BASELINE_MIN_SINGLES = 5;

export interface Ledger { credit: number; unit: 'usd' | 'chars' }

/**
 * The savings ledger: over the last LEDGER_WINDOW orchestrated reviews, what one judge would have been given minus what
 * every run was given. In dollars when the frozen baseline prices a character (a run that reported dollars counts
 * them, one that did not is priced at the baseline); otherwise in characters.
 */
export function ledger(costs: ReviewCost[], baseline: CostBaseline | undefined): Ledger {
    const rate = baseline?.usdPerChar ?? null;
    const recent = costs.filter(c => c.mode === 'orchestrator').slice(-LEDGER_WINDOW);
    if (rate === null) return { credit: recent.reduce((sum, c) => sum + c.projectedSingleChars - c.actualChars, 0), unit: 'chars' };
    return { credit: recent.reduce((sum, c) => sum + c.projectedSingleChars * rate - (c.actualUsd > 0 ? c.actualUsd : c.actualChars * rate), 0), unit: 'usd' };
}

/** What a split needs from the ledger: its projected size minus one pass's (shared inputs + the reviewable diff), in the ledger's unit. */
export function splitNeeds(splitChars: number, singleChars: number, unit: Ledger['unit'], baseline: CostBaseline | undefined): number {
    const extra = splitChars - singleChars;
    return unit === 'usd' ? extra * baseline!.usdPerChar! : extra;
}

export function formatLedger(amount: number, unit: Ledger['unit']): string {
    return unit === 'usd' ? `$${amount.toFixed(2)}` : `${Math.round(amount)} chars`;
}

/**
 * Each judge's context window, in tokens: the defaults its CLI or API runs with. Unverified against every model a team
 * may pick; a pass is held to half of it, so the prompt, the reads and the answer fit beside the diff.
 */
const CONTEXT_TOKENS: Record<ReviewerName, number> = { claude: 200_000, codex: 200_000, cursor: 200_000, api: 128_000 };
const CHARS_PER_TOKEN = 4;
const DIFF_SHARE_OF_CONTEXT = 0.5;
/** Diff a judge can read and reason over per second of its timeout: past this, the run times out before it answers. */
const DIFF_CHARS_PER_SECOND = 500;

/** The most diff one pass is given, from the judge's context window and its timeout. */
export function passLimit(judge: ReviewerName, timeoutMs: number): number {
    return Math.floor(Math.min(CONTEXT_TOKENS[judge] * CHARS_PER_TOKEN * DIFF_SHARE_OF_CONTEXT, (timeoutMs / 1000) * DIFF_CHARS_PER_SECOND));
}
