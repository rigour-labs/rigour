/**
 * The coverage table behind a readiness verdict (readiness.ts): one row per thing the review verified, found failed,
 * or did not verify, by category, from what the review, the receipt and the model reviewer's record already hold.
 * A row the review could not check says so: it is never counted as a pass.
 */
import type { ReadinessInput } from './readiness.js';
import { reviewerMissing } from './readiness.js';
import { criteriaRows } from './readiness-product.js';
import type { ReviewRecord } from './reviewer/record.js';

export type CoverageState = 'verified' | 'failed' | 'not verified';

export const COVERAGE_CATEGORIES = ['checks', 'changed units', 'team rules', 'lessons', 'human review points', 'acceptance criteria'] as const;
export type CoverageCategory = typeof COVERAGE_CATEGORIES[number];

export interface CoverageRow {
    category: CoverageCategory;
    /** What the row is about: a check, a changed unit, a criterion, or a kind of item when `count` is set. */
    item: string;
    state: CoverageState;
    /** How many the row stands for, when it is a count rather than one named item. */
    count?: number;
    detail?: string;
}

export function coverageRows(input: ReadinessInput): CoverageRow[] {
    if (!input.review.report) return [];
    const record = verdictRecord(input);
    const missing = reviewerMissing(input.reviewer);
    return [
        ...checkRows(input),
        ...unitRows(input, record),
        ...(record ? ruleRows(record) : [notChecked('team rules', 'team rules', missing)]),
        ...lessonRows(input, record, missing),
        ...(record ? pointRows(record) : [notChecked('human review points', 'human review points', missing)]),
        ...criteriaRows(input),
    ];
}

/** The reviewer's record, only when it gave a verdict. */
function verdictRecord({ reviewer }: ReadinessInput): ReviewRecord | undefined {
    return reviewer && !reviewerMissing(reviewer) ? reviewer.record : undefined;
}

function counted(category: CoverageCategory, item: string, state: CoverageState, count: number, detail?: string): CoverageRow[] {
    return count > 0 ? [{ category, item, state, count, ...(detail ? { detail } : {}) }] : [];
}

function notChecked(category: CoverageCategory, item: string, missing: string | undefined): CoverageRow {
    return { category, item, state: 'not verified', detail: `model review ${missing ?? 'gave no record'}` };
}

/** Every check the run reached. A check that found only notes reads FAIL in the summary and fails here too, with that said. */
function checkRows({ review }: ReadinessInput): CoverageRow[] {
    const quiet = review.findings.length === 0;
    return Object.entries(review.report?.summary ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([check, status]): CoverageRow => {
        if (status === 'PASS') return { category: 'checks', item: check, state: 'verified' };
        if (status === 'FAIL') return { category: 'checks', item: check, state: 'failed', ...(quiet ? { detail: 'notes only, never blocking' } : {}) };
        return { category: 'checks', item: check, state: 'not verified', detail: status === 'SKIP' ? 'not run' : 'could not run' };
    });
}

/** The changed functions: the model reviewer's coverage when it kept one, else the receipt of reviews before this one. */
function unitRows({ receipt }: ReadinessInput, record: ReviewRecord | undefined): CoverageRow[] {
    const coverage = record?.coverage;
    if (coverage) {
        return [
            ...counted('changed units', 'reviewed by the model', 'verified', coverage.accounted),
            ...coverage.not_reviewed.map((unit): CoverageRow => ({ category: 'changed units', item: unit, state: 'not verified', detail: 'not reviewed by the model' })),
            ...counted('changed units', 'not offered to the model', 'not verified', coverage.not_offered, 'past the limit'),
        ];
    }
    if (!receipt) return [{ category: 'changed units', item: 'changed functions', state: 'not verified', detail: 'no review recorded' }];
    const lowRisk = receipt.functions - receipt.reviewed - receipt.notCovered.length;
    return [
        ...counted('changed units', 'reviewed before this', 'verified', receipt.reviewed),
        ...receipt.notCovered.map((gap): CoverageRow => ({ category: 'changed units', item: `${gap.file}:${gap.start} ${gap.function}`, state: 'not verified', detail: gap.changedSinceReview ? 'changed after its review' : 'risky, not reviewed' })),
        ...counted('changed units', 'low risk', 'not verified', lowRisk, 'not reviewed'),
    ];
}

function ruleRows(record: ReviewRecord): CoverageRow[] {
    const rules = record.verified.rules;
    return [
        ...counted('team rules', 'followed', 'verified', rules.followed),
        ...counted('team rules', 'not applicable', 'verified', rules.not_applicable),
        ...counted('team rules', 'broken', 'failed', rules.broken),
        ...counted('team rules', 'not answered', 'not verified', rules.served - rules.followed - rules.broken - rules.not_applicable),
    ];
}

/** Lessons the compiled checks covered are verified by them; the rest only by the model reviewer. */
function lessonRows({ review }: ReadinessInput, record: ReviewRecord | undefined, missing: string | undefined): CoverageRow[] {
    const compiled = counted('lessons', 'covered by compiled checks', 'verified', review.covered.length);
    if (!record) return [...compiled, notChecked('lessons', 'other team lessons', missing)];
    const lessons = record.verified.lessons;
    return [
        ...compiled,
        ...counted('lessons', 'not repeated', 'verified', lessons.served - lessons.applied),
        ...counted('lessons', 'repeated by this change', 'failed', lessons.applied),
    ];
}

function pointRows(record: ReviewRecord): CoverageRow[] {
    if (record.blind) return [{ category: 'human review points', item: 'human review points', state: 'not verified', detail: 'not read (--blind)' }];
    const points = record.verified.prior_points;
    return [
        ...counted('human review points', 'resolved', 'verified', points.resolved),
        ...counted('human review points', 'open', 'failed', points.open),
        ...counted('human review points', 'to answer in the reply', 'not verified', points.answer_in_reply),
    ];
}
