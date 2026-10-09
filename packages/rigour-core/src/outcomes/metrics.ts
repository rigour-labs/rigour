/**
 * The outcome loop's numbers: the one place they are counted (Studio, `rigour outcomes --json` and telemetry read this,
 * never their own count). The shape is versioned and documented in docs/OUTCOMES.md, "Numbers".
 *
 * Counts only, over what this machine read. A rate is given only when at least MIN_FOR_RATE records are behind it;
 * below that it is null with the reason. Pull requests a review by Rigour saw and pull requests it did not are counted
 * side by side and never compared: teams choose which pull requests get reviewed, so the two groups differ, and a gap
 * between them is not Rigour's effect.
 */
import type { ReviewLesson } from '../review-learning/lessons.js';
import { pendingDecision } from '../review-learning/lessons.js';
import type { PrOutcome } from './outcome.js';

/** Fewer records than this give a count, never a percentage. */
const MIN_FOR_RATE = 10;

export interface Share {
    count: number;
    of: number;
    /** count / of, two decimals; null when `of` is under MIN_FOR_RATE. */
    rate: number | null;
    reason?: string;
}

export interface OutcomeMetrics {
    version: 1;
    records: { merged: number; settled: number; unsettled: number };
    /** Over settled records only: an open window can still change. */
    settled: {
        /** Over settled records whose CI result is known (passed or failed): one with no CI to read never dilutes it. */
        ciRegressed: Share;
        /** Settled records with no CI result to read. */
        ciUnknown: number;
        reverted: Share;
        /** A later commit on its files, inside the window, that says it fixes something. */
        fixedLater: Share;
        /** Side by side, never compared (see above). */
        reviewed: { prs: number; fixedLater: Share };
        notReviewed: { prs: number; fixedLater: Share };
    };
    /** What the model reviewer added on the settled pull requests a review by Rigour ran on. */
    model: {
        /**
         * The model's findings (blocking and should-fix) out of all findings, the deterministic checks' included, at
         * each pull request's first review that recorded both: before the review's own points changed the code. Rate
         * only from MIN_FOR_RATE such pull requests.
         */
        share: { model: number; checks: number; prs: number; rate: number | null; reason?: string };
        /** Dollars of every review round on a pull request, summed per pull request. Median only from MIN_FOR_RATE. */
        costPerPr: { prs: number; totalUsd: number; medianUsd: number | null; reason?: string };
    };
    lessons: {
        /** Candidates waiting on a person: a later fix on their lines, back to candidate, or taken back. */
        awaitingDecision: number;
        /** Promoted by a person after such evidence. */
        promotedFromEvidence: number;
        dismissed: number;
        /** Taken back by evidence and not promoted again since. */
        takenBack: number;
    };
}

/** One pull request's reviews by Rigour, from the threads' review events, oldest first. */
export interface PrReviews {
    /** The first review that recorded the deterministic checks' count: the model's findings and the checks' then. */
    first?: { model: number; checks: number };
    /** Every review round's dollars, summed. */
    usd: number;
}

/** `reviewed`: the pull requests a review by Rigour ran on, each with its reviews (the threads' review events). */
export function outcomeMetrics(records: PrOutcome[], lessons: ReviewLesson[], reviewed: Map<number, PrReviews>): OutcomeMetrics {
    const settled = records.filter(r => r.settled);
    const fixed = (r: PrOutcome) => r.followUps.some(f => f.fix);
    const inReview = settled.filter(r => reviewed.has(r.pr));
    const notInReview = settled.filter(r => !reviewed.has(r.pr));
    return {
        version: 1,
        records: { merged: records.length, settled: settled.length, unsettled: records.length - settled.length },
        settled: {
            ciRegressed: share(settled.filter(r => r.ci === 'failure').length, settled.filter(r => r.ci === 'success' || r.ci === 'failure').length),
            ciUnknown: settled.filter(r => r.ci !== 'success' && r.ci !== 'failure').length,
            reverted: share(settled.filter(r => !!r.reverted).length, settled.length),
            fixedLater: share(settled.filter(fixed).length, settled.length),
            reviewed: { prs: inReview.length, fixedLater: share(inReview.filter(fixed).length, inReview.length) },
            notReviewed: { prs: notInReview.length, fixedLater: share(notInReview.filter(fixed).length, notInReview.length) },
        },
        model: modelNumbers(inReview.map(r => reviewed.get(r.pr)).filter((x): x is PrReviews => !!x)),
        lessons: {
            awaitingDecision: lessons.filter(l => pendingDecision(l)).length,
            promotedFromEvidence: lessons.filter(promotedAfterEvidence).length,
            dismissed: lessons.filter(l => l.evidence.some(e => e.kind === 'dismissed')).length,
            takenBack: lessons.filter(l => pendingDecision(l)?.kind === 'demoted').length,
        },
    };
}

function modelNumbers(prs: PrReviews[]): OutcomeMetrics['model'] {
    const firsts = prs.flatMap(p => p.first ? [p.first] : []);
    const model = firsts.reduce((n, f) => n + f.model, 0);
    const checks = firsts.reduce((n, f) => n + f.checks, 0);
    const few = (n: number) => n < MIN_FOR_RATE ? { reason: `fewer than ${MIN_FOR_RATE} pull requests: a count, not a rate` } : {};
    const usd = prs.map(p => p.usd).sort((a, b) => a - b);
    const mid = usd.length >> 1;
    return {
        share: { model, checks, prs: firsts.length, rate: firsts.length >= MIN_FOR_RATE && model + checks > 0 ? Math.round((model / (model + checks)) * 100) / 100 : null, ...few(firsts.length) },
        costPerPr: {
            prs: usd.length,
            totalUsd: Math.round(usd.reduce((a, b) => a + b, 0) * 100) / 100,
            medianUsd: usd.length >= MIN_FOR_RATE ? Math.round((usd.length % 2 ? usd[mid] : (usd[mid - 1] + usd[mid]) / 2) * 100) / 100 : null,
            ...few(usd.length),
        },
    };
}

function share(count: number, of: number): Share {
    return of >= MIN_FOR_RATE
        ? { count, of, rate: Math.round((count / of) * 100) / 100 }
        : { count, of, rate: null, reason: `fewer than ${MIN_FOR_RATE} records: a count, not a rate` };
}

/** A person's promotion that came after a later fix on its lines, a reclassification or a take-back. */
function promotedAfterEvidence(lesson: ReviewLesson): boolean {
    const evidenceAt = lesson.evidence.findIndex(e => e.kind === 'lines' || e.kind === 'reclassified' || e.kind === 'demoted');
    return evidenceAt >= 0 && lesson.evidence.slice(evidenceAt + 1).some(e => e.kind === 'accepted') && lesson.state === 'verified';
}
