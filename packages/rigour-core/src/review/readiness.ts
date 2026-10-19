/**
 * Two questions every review answers, from what it already holds: is the change technically ready, and is it product
 * ready. Each is ready, not ready or unknown, with the reasons, and a coverage table says what was verified, what
 * failed and what was not verified. Nothing here changes what blocks or the review's status: it reads them.
 *
 * Technically ready:
 *   not ready  a blocking finding (a check that failed on the change), or an open item from the model reviewer;
 *   unknown    the review is ERROR, the model review was required and did not give a verdict, or it was required and
 *              left changed units unreviewed;
 *   ready      everything that ran passed and nothing required was left unverified; what did not run is a caveat.
 * Product ready:
 *   unknown    no acceptance criteria in the description ("Done when", "Acceptance criteria", ...), or criteria the
 *              model reviewer's goal step did not judge, item by item;
 *   not ready  the reviewer recorded a criterion as not met, with a quote that checked out;
 *   ready      the reviewer recorded every criterion as met. Never a guess: an unjudged item is not verified.
 */
import type { Config } from '../types/index.js';
import type { QualityReceipt } from './receipt.js';
import type { ReviewResult } from './review.js';
import type { ReviewerResult } from './reviewer.js';
import { coverageRows, type CoverageRow } from './readiness-coverage.js';
import { productReadiness } from './readiness-product.js';

export type ReadyState = 'ready' | 'not ready' | 'unknown';

export interface ReadinessVerdict {
    state: ReadyState;
    /** Why the state is what it is: for not ready and unknown, what decided it; for product, the short reason. */
    reasons: string[];
    /** What did not run or was not verified, never hidden behind a ready. */
    caveats: string[];
}

export interface Readiness {
    technical: ReadinessVerdict;
    product: ReadinessVerdict;
    coverage: CoverageRow[];
}

export interface ReadinessInput {
    review: ReviewResult;
    /** The model reviewer's result, when it was asked for. */
    reviewer?: ReviewerResult;
    receipt?: QualityReceipt | null;
    /** The pull request's description (title and body), when one was read: where the acceptance criteria are. */
    description?: string;
    /** The team or this run requires the model reviewer: without its verdict, the change is not known to be ready. */
    reviewerRequired: boolean;
}

/** The model reviewer is required when this run asked for it, or the team holds every push for its verdict (`on_push: wait`). */
export function reviewerRequired(config: Config, asked: boolean): boolean {
    const team = config.review?.reviewer;
    return asked || (!!team?.enabled && team.on_push === 'wait');
}

export function readiness(input: ReadinessInput): Readiness {
    const coverage = coverageRows(input);
    return { technical: technicalReadiness(input, coverage), product: productReadiness(input, coverage), coverage };
}

function technicalReadiness(input: ReadinessInput, coverage: CoverageRow[]): ReadinessVerdict {
    if (!input.review.report) return { state: 'unknown', reasons: ['no changes to review'], caveats: [] };
    const blocking = blockingReasons(input);
    const unknown = unknownReasons(input);
    const caveats = caveatsOf(input, coverage, blocking.length > 0);
    if (blocking.length) return { state: 'not ready', reasons: blocking, caveats: [...unknown, ...caveats] };
    if (unknown.length) return { state: 'unknown', reasons: unknown, caveats };
    return { state: 'ready', reasons: [], caveats };
}

function blockingReasons({ review, reviewer }: ReadinessInput): string[] {
    const reasons: string[] = [];
    if (review.findings.length) reasons.push(plural(review.findings.length, 'blocking finding'));
    if (reviewer?.outcome === 'findings') reasons.push(plural(reviewer.items.length, 'open reviewer item'));
    return reasons;
}

function unknownReasons({ review, reviewer, reviewerRequired }: ReadinessInput): string[] {
    const reasons: string[] = [];
    if (review.status === 'ERROR') {
        if (review.deepError) reasons.push(`deep analysis did not run (${review.deepError})`);
        if (review.gateErrors.length) reasons.push(`could not run: ${review.gateErrors.join(', ')}`);
        if (!review.deepError && !review.gateErrors.length) reasons.push('the review ended in ERROR');
    }
    if (!reviewerRequired) return reasons;
    const missing = reviewerMissing(reviewer);
    if (missing) reasons.push(`model review required, ${missing}`);
    const notReviewed = reviewer?.record?.coverage?.not_reviewed.length ?? 0;
    if (!missing && notReviewed) reasons.push(`model review required, ${plural(notReviewed, 'changed unit')} not reviewed`);
    return reasons;
}

/** Why the model review gave no verdict, or undefined when it gave one. */
export function reviewerMissing(reviewer: ReviewerResult | undefined): string | undefined {
    if (!reviewer) return 'not run';
    if (reviewer.outcome === 'unavailable') return `unavailable (${reviewer.reason ?? 'no verdict'})`;
    if (reviewer.outcome === 'skipped') return `skipped (${reviewer.reason ?? 'not asked'})`;
    return undefined;
}

function caveatsOf({ review, reviewer, reviewerRequired }: ReadinessInput, coverage: CoverageRow[], blocked: boolean): string[] {
    const caveats: string[] = [];
    const missing = reviewerMissing(reviewer);
    if (!reviewerRequired && missing) caveats.push(`model review ${missing}`);
    const notReviewed = reviewer?.record?.coverage?.not_reviewed.length ?? 0;
    if (!reviewerRequired && notReviewed) caveats.push(`${plural(notReviewed, 'changed unit')} not reviewed by the model`);
    const skipped = Object.values(review.report?.summary ?? {}).filter(status => status === 'SKIP').length;
    if (skipped) caveats.push(`${plural(skipped, 'check')} not run`);
    if (review.report?.stats?.deep?.skipped) caveats.push(`deep review skipped (${review.report.stats.deep.skipped})`);
    const failedQuietly = coverage.filter(row => row.state === 'failed' && row.category !== 'acceptance criteria');
    if (failedQuietly.length && !blocked) {
        caveats.push(`${plural(failedQuietly.reduce((n, row) => n + (row.count ?? 1), 0), 'item')} failed without blocking (see coverage)`);
    }
    return caveats;
}

function plural(n: number, noun: string): string {
    return `${n} ${noun}${n === 1 ? '' : 's'}`;
}
