/**
 * Product readiness (readiness.ts): the description's acceptance criteria, as goal/goal.ts reads them ("Done when",
 * "Acceptance criteria", "Definition of done", "Success criteria"), each judged only by what the model reviewer's goal
 * step recorded. An item the reviewer did not judge, or judged without a quote that checked out, is not verified.
 */
import { parseGoal } from '../goal/goal.js';
import type { ReadinessInput, ReadinessVerdict } from './readiness.js';
import { reviewerMissing } from './readiness.js';
import type { CoverageRow } from './readiness-coverage.js';

/** The criteria the reviewer read from the pull request, else those in the description given; undefined when none was read. */
function acceptanceCriteria({ reviewer, description }: ReadinessInput): string[] | undefined {
    if (reviewer?.criteria?.length) return reviewer.criteria;
    if (description === undefined) return reviewer?.criteria;
    return parseGoal(description).doneWhen.map(item => item.text);
}

export function criteriaRows(input: ReadinessInput): CoverageRow[] {
    return (acceptanceCriteria(input) ?? []).map(text => ({ category: 'acceptance criteria' as const, item: text, ...criterionState(text, input) }));
}

/** A judge lists an item as given (`[done] text`) or as written: both match the criterion. */
function normalized(text: string): string {
    return text.replace(/^\s*\[(?:done|invariant)\]\s*/i, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function criterionState(text: string, { reviewer }: ReadinessInput): Pick<CoverageRow, 'state' | 'detail'> {
    if (!reviewer?.goal) return { state: 'not verified', detail: 'not checked' };
    const answer = reviewer.goal.find(g => normalized(g.item) === normalized(text));
    if (!answer) return { state: 'not verified', detail: 'not judged by the model reviewer' };
    if (answer.met === true) return { state: 'verified' };
    if (answer.met === null) return { state: 'not verified', detail: 'the reviewer could not tell' };
    const shown = [...reviewer.items, ...reviewer.advisory].some(item => item.kind === 'goal' && normalized(item.issue).endsWith(normalized(text)));
    return shown ? { state: 'failed', detail: 'not met' } : { state: 'not verified', detail: 'judged not met, but its quote did not check out' };
}

export function productReadiness(input: ReadinessInput, coverage: CoverageRow[]): ReadinessVerdict {
    const rows = coverage.filter(row => row.category === 'acceptance criteria');
    if (!rows.length) return { state: 'unknown', reasons: ['no acceptance criteria'], caveats: noCriteriaWhy(input) };
    if (!input.reviewer?.goal) return { state: 'unknown', reasons: ['not checked'], caveats: [goalNotRun(input)] };
    const failed = rows.filter(row => row.state === 'failed').length;
    const verified = rows.filter(row => row.state === 'verified').length;
    const unverified = rows.length - failed - verified;
    const caveats = unverified ? [`${unverified} of ${criteria(rows.length)} not verified`] : [];
    if (failed) return { state: 'not ready', reasons: [`${failed} of ${criteria(rows.length)} not met`], caveats };
    if (!unverified) return { state: 'ready', reasons: [`${verified} of ${criteria(rows.length)} met`], caveats };
    return { state: 'unknown', reasons: ['not checked'], caveats };
}

function criteria(n: number): string {
    return `${n} criteri${n === 1 ? 'on' : 'a'}`;
}

function noCriteriaWhy({ reviewer, description }: ReadinessInput): string[] {
    if (description === undefined && !reviewer?.criteria) return ['no pull request description was read (--pr-body, or a pull request)'];
    return ['the description has no "Done when" or "Acceptance criteria" section'];
}

function goalNotRun({ reviewer }: ReadinessInput): string {
    const missing = reviewerMissing(reviewer);
    if (missing) return `model review ${missing}`;
    if (reviewer?.mode?.specialists?.missing.includes('rules-and-goal')) return 'the rules-and-goal step did not return';
    return 'the goal step did not run (review.goal is off)';
}
