/**
 * Cheap-model-first tiering (off by default; review.reviewer.tiers.cheap names a cheaper model per judge). Which model
 * reviews a change is decided BEFORE any run, from facts about the change only: never by a model, and never from a
 * model's findings. A change with something a cheaper model may miss gets the team's model:
 *
 *   a required floor, human reviews to check, open items carried from the last verdict, a migration, a security
 *   finding from the checks, a declared goal, or a risky changed function (the router's score)
 *
 * Anything else gets the cheap model. After the run, the only escalation is an answer that is not a valid verdict: the
 * one retry the reviewer already makes uses the team's model. What blocks is unchanged: the same evidence contract.
 *
 * The rule a tier must keep: on average, a review costs no more than one judge would have. Over the last
 * TIER_WINDOW reviews tiering ran on, actual cost against what one judge would have been given (the frozen baseline's
 * dollars per character, else characters); above it, tiering turns itself off and the review record says so.
 */
import type { CostBaseline, ReviewCost } from './store.js';

/** Recent tiered reviews the self-disable rule reads. */
const TIER_WINDOW = 20;
/** Tiered reviews needed before the rule can turn tiering off. */
const TIER_MIN = 5;

export interface TierDecision {
    tier: 'cheap' | 'strong';
    /** The cheap model, when the tier is cheap. */
    model?: string;
    why: string;
    /** Why tiering turned itself off, when it did. */
    disabled?: string;
    /** Why the cheap model's run was retried on the team's model: its answer was not a valid verdict. */
    escalated?: string;
}

export interface TierFacts {
    required: boolean;
    humanReviews: number;
    carried: number;
    migration: boolean;
    securityChecks: number;
    goal: boolean;
    /** Risky changed functions (the router's score); undefined when it could not score the change. */
    risky: number | undefined;
}

/** The tier for one judge's review; undefined when no cheap model is set for it (tiering is off). */
export function chooseTier(cheap: Record<string, string>, judge: string, facts: TierFacts, costs: ReviewCost[], baseline: CostBaseline | undefined): TierDecision | undefined {
    const model = cheap[judge];
    if (!model) return undefined;
    const disabled = overBudget(costs, baseline);
    if (disabled) return { tier: 'strong', why: 'tiering turned itself off', disabled };
    const strong = (why: string): TierDecision => ({ tier: 'strong', why });
    if (facts.required) return strong('a required floor');
    if (facts.humanReviews > 0) return strong(`${facts.humanReviews} human review(s) to check`);
    if (facts.carried > 0) return strong(`${facts.carried} open item(s) carried from the last verdict`);
    if (facts.migration) return strong('the change adds or edits a migration');
    if (facts.securityChecks > 0) return strong(`${facts.securityChecks} security finding(s) from the checks`);
    if (facts.goal) return strong('the description declares a goal to check');
    if (facts.risky === undefined) return strong('the risk router could not score the change');
    if (facts.risky > 0) return strong(`${facts.risky} risky changed function(s)`);
    return { tier: 'cheap', model, why: 'no risk signal: the cheap model' };
}

/** Why tiering must turn itself off: its recent reviews cost more, on average, than one judge would have. */
function overBudget(costs: ReviewCost[], baseline: CostBaseline | undefined): string | undefined {
    const tiered = costs.filter(c => c.tier).slice(-TIER_WINDOW);
    if (tiered.length < TIER_MIN) return undefined;
    const rate = baseline?.usdPerChar ?? null;
    const single = tiered.reduce((sum, c) => sum + c.projectedSingleChars * (rate ?? 1), 0);
    const actual = tiered.reduce((sum, c) => sum + (rate === null ? c.actualChars : c.actualUsd > 0 ? c.actualUsd : c.actualChars * rate), 0);
    if (single <= 0 || actual <= single) return undefined;
    return `the last ${tiered.length} tiered reviews cost ${(actual / single).toFixed(2)}x what one judge would have (${rate === null ? 'characters' : 'dollars'})`;
}
