/**
 * Two questions every review answers, from what it already holds: is the change technically ready, and is it product
 * ready. Each is ready, not ready or unknown, with the reasons, and a coverage table says what was verified, what
 * failed, what was noted (found, never blocking) and what was not verified. Nothing here changes what blocks or the
 * review's status: it reads them.
 *
 * Technically ready:
 *   not ready  a blocking finding, or an open item from the model reviewer;
 *   unknown    the review is ERROR, or this run asked for the model review and it gave no verdict, or left changed
 *              units unreviewed;
 *   ready      everything that ran passed and nothing this run asked for was left unverified; what did not run, what
 *              could not run and what was noted are caveats, never hidden.
 * Product ready (readiness-product.ts):
 *   unknown    no acceptance criteria, or criteria nobody checked, or checked without evidence;
 *   not ready  a criterion shown not met;
 *   ready      every criterion shown met. Never a guess.
 */
import type { QualityReceipt } from './receipt.js';
import type { ReviewResult } from './review.js';
import type { ReviewerResult } from './reviewer.js';
import { coverageRows, type CoverageRow } from './readiness-coverage.js';
import { productReadiness } from './readiness-product.js';

export type ReadyState = 'ready' | 'not ready' | 'unknown';

export interface ReadinessVerdict {
    state: ReadyState;
    /** What decided the state: for not ready and unknown, why; for product, the short reason. */
    reasons: string[];
    /** What did not run, could not run, was not verified or was noted: never hidden behind a ready. */
    caveats: string[];
}

export interface Readiness {
    technical: ReadinessVerdict;
    product: ReadinessVerdict;
    coverage: CoverageRow[];
}

export interface ReadinessInput {
    review: ReviewResult;
    /** The model reviewer's result: this run's when it asked for one, else the stored verdict on this commit, if any (reviewer/stored.ts). */
    reviewer?: ReviewerResult;
    receipt?: QualityReceipt | null;
    /** The pull request's description, when one was read: where the acceptance criteria are, and what a stored verdict's description hash is compared with. */
    description?: string;
    /** This run asked for the model review (`--reviewer`): without its verdict, the change is not known to be ready. */
    reviewerAsked: boolean;
}

export function readiness(input: ReadinessInput): Readiness {
    const coverage = coverageRows(input);
    return { technical: technicalReadiness(input, coverage), product: productReadiness(input, coverage), coverage };
}

function technicalReadiness(input: ReadinessInput, coverage: CoverageRow[]): ReadinessVerdict {
    if (!input.review.report) return { state: 'unknown', reasons: ['no changes to review'], caveats: [] };
    const blocking = blockingReasons(input);
    const unknown = unknownReasons(input);
    const caveats = caveatsOf(input, coverage);
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

function unknownReasons({ review, reviewer, reviewerAsked }: ReadinessInput): string[] {
    const reasons: string[] = [];
    if (review.status === 'ERROR') {
        if (review.deepError) reasons.push(`deep analysis did not run (${review.deepError})`);
        if (review.gateErrors.length) reasons.push(`could not run: ${review.gateErrors.join(', ')}`);
        if (!review.deepError && !review.gateErrors.length) reasons.push('the review ended in ERROR');
    }
    if (!reviewerAsked) return reasons;
    const missing = reviewerMissing(reviewer);
    if (missing) reasons.push(`model review asked for, ${missing}`);
    const notReviewed = reviewer?.record?.coverage?.not_reviewed?.length ?? 0;
    if (!missing && notReviewed) reasons.push(`model review asked for, ${plural(notReviewed, 'changed unit')} not reviewed`);
    return reasons;
}

/** Why the model review gave no verdict, or undefined when it gave one. */
export function reviewerMissing(reviewer: ReviewerResult | undefined): string | undefined {
    if (!reviewer) return 'not run';
    if (reviewer.outcome === 'unavailable') return `unavailable (${reviewer.reason ?? 'no verdict'})`;
    if (reviewer.outcome === 'skipped') return `skipped (${reviewer.reason ?? 'not asked'})`;
    return undefined;
}

function caveatsOf({ review, reviewer, reviewerAsked }: ReadinessInput, coverage: CoverageRow[]): string[] {
    const caveats = reviewerAsked ? [] : modelCaveats(reviewer);
    const statuses = Object.values(review.report?.summary ?? {});
    const skipped = statuses.filter(status => status === 'SKIP').length;
    if (skipped) caveats.push(`${plural(skipped, 'check')} not run`);
    // An ERROR status already says which checks could not run; a heuristic check that crashed leaves PASS and says it here.
    const crashed = statuses.filter(status => status === 'ERROR').length;
    if (crashed && review.status !== 'ERROR') caveats.push(`${plural(crashed, 'check')} could not run`);
    if (review.report?.stats?.deep?.skipped) caveats.push(`deep review skipped (${review.report.stats.deep.skipped})`);
    const noted = coverage.filter(row => row.state === 'noted').reduce((n, row) => n + (row.count ?? 1), 0);
    if (noted) caveats.push(`${noted} noted`);
    return caveats;
}

/** A model review this run did not ask for: not run, or the stored verdict on this commit, with what it left unreviewed. */
function modelCaveats(reviewer: ReviewerResult | undefined): string[] {
    const missing = reviewerMissing(reviewer);
    if (missing) return [`model review ${missing}`];
    const notReviewed = reviewer?.record?.coverage?.not_reviewed?.length ?? 0;
    return [
        `model review from the stored verdict on this commit${reviewer?.record?.at ? ` (${reviewer.record.at})` : ''}`,
        ...(notReviewed ? [`${plural(notReviewed, 'changed unit')} not reviewed by the model`] : []),
    ];
}

export function plural(n: number, noun: string): string {
    return `${n} ${noun}${n === 1 ? '' : 's'}`;
}
