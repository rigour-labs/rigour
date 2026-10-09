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

/** `reviewed`: the pull requests a review by Rigour ran on (the threads' review events). */
export function outcomeMetrics(records: PrOutcome[], lessons: ReviewLesson[], reviewed: Set<number>): OutcomeMetrics {
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
        lessons: {
            awaitingDecision: lessons.filter(l => pendingDecision(l)).length,
            promotedFromEvidence: lessons.filter(promotedAfterEvidence).length,
            dismissed: lessons.filter(l => l.evidence.some(e => e.kind === 'dismissed')).length,
            takenBack: lessons.filter(l => pendingDecision(l)?.kind === 'demoted').length,
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
