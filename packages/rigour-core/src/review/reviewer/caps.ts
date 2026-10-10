/**
 * The spending caps every model run Rigour starts is checked against, in one place: the reviewer's judges, retries,
 * cross-examinations and follow-ups, the rule writer, and the deep review's cloud model.
 */

/**
 * Why the caps leave no room for `planned` more runs today, or nothing when they do. `review` is what the current review
 * (or one rule-writing or deep run) has spent so far, against `max_usd_per_review`.
 */
export function overBudget(spent: { runs: number; usd: number }, caps: { max_runs_per_day?: number; max_usd_per_day?: number; max_usd_per_review?: number }, planned: number, review = 0): string | undefined {
    if (caps.max_usd_per_review !== undefined && review >= caps.max_usd_per_review) return `this review's cost cap is reached: $${review.toFixed(2)} of $${caps.max_usd_per_review.toFixed(2)} spent by this review (review.reviewer.max_usd_per_review)`;
    if (caps.max_runs_per_day !== undefined && spent.runs + planned > caps.max_runs_per_day) return `the daily run cap is reached: ${spent.runs} of ${caps.max_runs_per_day} agent runs used today in this repository, and this needs ${planned} more (review.reviewer.max_runs_per_day)`;
    if (caps.max_usd_per_day !== undefined && spent.usd >= caps.max_usd_per_day) return `the daily cost cap is reached: $${spent.usd.toFixed(2)} of $${caps.max_usd_per_day.toFixed(2)} reported today in this repository (review.reviewer.max_usd_per_day)`;
    return undefined;
}
