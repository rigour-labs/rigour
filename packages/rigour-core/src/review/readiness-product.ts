/**
 * Product readiness (readiness.ts): the description's acceptance criteria, as goal/goal.ts reads them ("Done when",
 * "Acceptance criteria", "Definition of done", "Success criteria"), each one shown met or not by evidence only.
 *
 * A criterion that names a file is the goal check's: met when the change touches every file it names, failed when it
 * does not. Any other criterion is the model reviewer's goal step: failed when any judge shows it not met with a quote
 * that checks out against the checkout; verified only when every judge that answered says met, each with a quote that
 * checks out. Anything else (no answer, no evidence, a quote that does not check out, a judge that could not tell) is
 * not verified.
 */
import type { ReadinessInput, ReadinessVerdict } from './readiness.js';
import { reviewerMissing } from './readiness.js';
import type { CoverageRow } from './readiness-coverage.js';
import { acceptanceCriteria } from './reviewer/answers.js';

type Criterion = { text: string; paths: string[] };
type State = Pick<CoverageRow, 'state' | 'detail'>;

const NOT_CHECKED = 'not checked';
const GOAL_CHECK_NOT_RUN = 'checked by the goal check (not run)';

/** The criteria the reviewer read from the pull request, else those in the description given; undefined when none was read. */
function criteriaOf({ reviewer, description }: ReadinessInput): Criterion[] | undefined {
    if (reviewer?.criteria?.length) return reviewer.criteria;
    return description === undefined ? reviewer?.criteria : acceptanceCriteria(description);
}

export function criteriaRows(input: ReadinessInput): CoverageRow[] {
    return (criteriaOf(input) ?? []).map(c => ({ category: 'acceptance criteria' as const, item: c.text, ...(c.paths.length ? byGoalCheck(c, input) : byReviewer(c, input)) }));
}

/** A judge lists an item as given (`[done] text`) or as written: both match the criterion. */
function normalized(text: string): string {
    return text.replace(/^\s*\[(?:done|invariant)\]\s*/i, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function byGoalCheck(c: Criterion, { review }: ReadinessInput): State {
    if (!review.goal?.doneWhen.some(item => item.text === c.text)) return { state: 'not verified', detail: GOAL_CHECK_NOT_RUN };
    const missed = [...review.findings, ...review.advisory].some(f => f.id === 'goal-done-when' && !f.advisory && f.details.endsWith(`says: ${c.text}`));
    return missed ? { state: 'failed', detail: 'a file it names is not changed (goal check)' } : { state: 'verified', detail: 'every file it names is changed (goal check)' };
}

function byReviewer(c: Criterion, { reviewer }: ReadinessInput): State {
    if (!reviewer?.goal) return { state: 'not verified', detail: NOT_CHECKED };
    const answers = reviewer.goal.filter(g => normalized(g.item) === normalized(c.text));
    if (!answers.length) return { state: 'not verified', detail: 'not judged by the model reviewer' };
    if (answers.some(a => a.met === false && a.checked)) return { state: 'failed', detail: 'not met' };
    if (answers.every(a => a.met === true && a.checked)) return { state: 'verified', detail: 'met' };
    if (answers.some(a => a.met === false)) return { state: 'not verified', detail: 'judged not met, but its quote did not check out' };
    if (answers.some(a => a.met === null)) return { state: 'not verified', detail: 'the reviewer could not tell' };
    return { state: 'not verified', detail: 'no evidence' };
}

export function productReadiness(input: ReadinessInput, coverage: CoverageRow[]): ReadinessVerdict {
    const rows = coverage.filter(row => row.category === 'acceptance criteria');
    if (!rows.length) return { state: 'unknown', reasons: ['no acceptance criteria'], caveats: noCriteriaWhy(input) };
    const failed = rows.filter(row => row.state === 'failed').length;
    const verified = rows.filter(row => row.state === 'verified').length;
    const unverified = rows.filter(row => row.state === 'not verified');
    const caveats = [...(unverified.length ? [`${unverified.length} of ${criteria(rows.length)} not verified`] : []), ...notRunWhy(input, unverified)];
    if (failed) return { state: 'not ready', reasons: [`${failed} of ${criteria(rows.length)} not met`], caveats };
    if (!unverified.length) return { state: 'ready', reasons: [`${verified} of ${criteria(rows.length)} met`], caveats };
    const nothingRan = !verified && unverified.every(row => row.detail === NOT_CHECKED || row.detail === GOAL_CHECK_NOT_RUN);
    return { state: 'unknown', reasons: [nothingRan ? 'not checked' : 'not verified'], caveats };
}

function criteria(n: number): string {
    return `${n} criteri${n === 1 ? 'on' : 'a'}`;
}

function noCriteriaWhy({ reviewer, description }: ReadinessInput): string[] {
    if (description === undefined && !reviewer?.criteria) return ['no pull request description was read (--pr-body, or a pull request)'];
    return ['the description has no "Done when" or "Acceptance criteria" section'];
}

/** Why the criteria nobody checked were not checked: the model's goal step, or the goal check, did not run. */
function notRunWhy({ reviewer }: ReadinessInput, unverified: CoverageRow[]): string[] {
    const why: string[] = [];
    if (unverified.some(row => row.detail === NOT_CHECKED)) {
        const missing = reviewerMissing(reviewer);
        if (missing) why.push(`model review ${missing}`);
        else if (reviewer?.mode?.specialists?.missing.includes('rules-and-goal')) why.push('the rules-and-goal step did not return');
        else why.push('the goal step did not run (review.goal is off)');
    }
    if (unverified.some(row => row.detail === GOAL_CHECK_NOT_RUN)) why.push('the goal check did not run (review.goal is off, or no description)');
    return why;
}
