/**
 * The review orchestrator (opt-in, experimental): instead of one judge doing every step, a fixed set of specialist
 * judges each do their part of the same review, in parallel, from the same inputs built once (the diff, the team's
 * knowledge, the hints, the human reviews and the description: the prompt and its files are shared; only a focus
 * block differs). Their verdicts merge through the reviewer's own accounting, so the evidence contract, the quote check
 * and what blocks are unchanged; an item two specialists both raise is one item that names both.
 *
 * Fails safe: a specialist with no verdict is named as missing, and its part reads "not reviewed", never "passed". With
 * at least half of them back the result stands, partial; with fewer, the caller falls back to the single review if the
 * caps still allow it, and the review is otherwise unavailable. Every run counts against the caps.
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

/** The block a specialist's prompt ends with: its part of the review, and that the other parts are not its to report. */
export function focusBlock(specialist: Specialist): string {
    return `

You are one of ${SPECIALISTS.length} specialists reviewing this pull request together; the others cover the rest. Your part:
${specialist.title}. Do step(s) ${specialist.steps.join(', ')} above, fully.${specialist.classes.length ? ` Report findings only of class ${specialist.classes.join(', ')}.` : ''}
${specialist.focus} Leave every other list in the JSON empty ([]): another specialist covers it, and repeating it costs the team twice.`;
}

export interface OrchestratedRun {
    /** The specialists' verdicts that came back, each tagged `<judge>:<specialist>`. */
    parts: Verdict[];
    returned: string[];
    missing: string[];
    /** At least half returned: the result stands, partial when some are missing. */
    stands: boolean;
}

/**
 * Asks every specialist at once through `ask` (one judge run each, counted against the caps by the caller) and keeps
 * what came back. `ask` returns a verdict, or an error for a run with no verdict.
 */
export async function runSpecialists(judge: string, ask: (specialist: Specialist) => Promise<{ verdict: Verdict } | { error: string }>): Promise<OrchestratedRun> {
    const answers = await Promise.all(SPECIALISTS.map(async specialist => ({ specialist, answer: await ask(specialist) })));
    const parts: Verdict[] = [];
    const returned: string[] = [];
    const missing: string[] = [];
    for (const { specialist, answer } of answers) {
        if ('verdict' in answer) {
            parts.push({ ...answer.verdict, reviewer: `${judge}:${specialist.id}` });
            returned.push(specialist.id);
        } else missing.push(specialist.id);
    }
    return { parts, returned, missing, stands: returned.length * 2 >= SPECIALISTS.length };
}
