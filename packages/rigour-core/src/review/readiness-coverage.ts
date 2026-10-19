/**
 * The coverage table behind a readiness verdict (readiness.ts): one row per thing the review verified, found failed
 * (it blocks), noted (found, never blocking) or did not verify, by category, from what the review, the receipt and
 * the model reviewer's record already hold. A row the review could not check says so: it is never counted as a pass.
 * A record written before a part of it existed reads that part as not verified.
 */
import type { ReadinessInput } from './readiness.js';
import { plural, reviewerMissing } from './readiness.js';
import { criteriaRows } from './readiness-product.js';
import type { ReviewRecord } from './reviewer/record.js';

export type CoverageState = 'verified' | 'failed' | 'noted' | 'not verified';

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

const NOT_RECORDED = 'not in the stored record';

export function coverageRows(input: ReadinessInput): CoverageRow[] {
    if (!input.review.report) return [];
    const record = verdictRecord(input);
    const missing = reviewerMissing(input.reviewer);
    return [
        ...checkRows(input),
        ...unitRows(input, record),
        ...(record ? ruleRows(input, record) : [notChecked('team rules', 'team rules', missing)]),
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

/**
 * Every check the run reached. A check fails only when a blocking finding came from it; one whose findings never block
 * is noted. When a blocking finding cannot be tied to a check, no failed check can be shown to be only notes.
 */
function checkRows({ review }: ReadinessInput): CoverageRow[] {
    const summary = review.report?.summary ?? {};
    const blocking = review.blockingByCheck;
    const untied = Object.entries(blocking).filter(([check]) => !(check in summary)).reduce((n, [, count]) => n + count, 0);
    return Object.entries(summary).sort(([a], [b]) => a.localeCompare(b)).map(([check, status]): CoverageRow => {
        const row = { category: 'checks' as const, item: check };
        if (status === 'PASS') return { ...row, state: 'verified' };
        if (status === 'SKIP') return { ...row, state: 'not verified', detail: 'not run' };
        if (status !== 'FAIL') return { ...row, state: 'not verified', detail: 'could not run' };
        if (blocking[check]) return { ...row, state: 'failed', detail: plural(blocking[check], 'blocking finding') };
        if (untied) return { ...row, state: 'failed', detail: 'a blocking finding could not be tied to its check' };
        return { ...row, state: 'noted', detail: 'notes only, never blocking' };
    });
}

/** The changed functions: the model reviewer's coverage when it kept one, else the receipt of reviews before this one. */
function unitRows({ receipt }: ReadinessInput, record: ReviewRecord | undefined): CoverageRow[] {
    const coverage = record?.coverage;
    if (coverage) {
        return [
            ...counted('changed units', 'reviewed by the model', 'verified', coverage.accounted ?? 0),
            ...(coverage.not_reviewed ?? []).map((unit): CoverageRow => ({ category: 'changed units', item: unit, state: 'not verified', detail: 'not reviewed by the model' })),
            ...counted('changed units', 'not offered to the model', 'not verified', coverage.not_offered ?? 0, 'past the limit'),
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

/** A broken rule the team wrote as a requirement blocks (an open item); one written as guidance is noted. */
function ruleRows({ reviewer }: ReadinessInput, record: ReviewRecord): CoverageRow[] {
    const rules = record.verified?.rules;
    if (!rules) return [{ category: 'team rules', item: 'team rules', state: 'not verified', detail: NOT_RECORDED }];
    const required = Math.min(rules.broken ?? 0, (reviewer?.items ?? []).filter(item => item.kind === 'rule').length);
    const answered = (rules.followed ?? 0) + (rules.broken ?? 0) + (rules.not_applicable ?? 0);
    return [
        ...counted('team rules', 'followed', 'verified', rules.followed ?? 0),
        ...counted('team rules', 'not applicable', 'verified', rules.not_applicable ?? 0),
        ...counted('team rules', 'broken', 'failed', required, 'a requirement'),
        ...counted('team rules', 'broken', 'noted', (rules.broken ?? 0) - required, 'guidance, never blocks'),
        ...counted('team rules', 'not answered', 'not verified', (rules.served ?? 0) - answered),
    ];
}

/** Lessons the compiled checks covered are verified by them; the rest only by what the judges answered, lesson by lesson. */
function lessonRows({ review, reviewer }: ReadinessInput, record: ReviewRecord | undefined, missing: string | undefined): CoverageRow[] {
    const compiled = counted('lessons', 'covered by compiled checks', 'verified', review.covered.length);
    if (!record) return [...compiled, notChecked('lessons', 'other team lessons', missing)];
    const lessons = record.verified?.lessons;
    if (!lessons) return [...compiled, { category: 'lessons', item: 'other team lessons', state: 'not verified', detail: NOT_RECORDED }];
    const answers = reviewer?.lessonAnswers ?? { repeated: lessons.applied ?? 0, notRepeated: 0 };
    return [
        ...compiled,
        ...counted('lessons', 'not repeated', 'verified', answers.notRepeated),
        ...counted('lessons', 'repeated by this change', 'noted', answers.repeated),
        ...counted('lessons', 'not answered', 'not verified', (lessons.served ?? 0) - answers.repeated - answers.notRepeated),
    ];
}

function pointRows(record: ReviewRecord): CoverageRow[] {
    if (record.blind) return [{ category: 'human review points', item: 'human review points', state: 'not verified', detail: 'not read (--blind)' }];
    const points = record.verified?.prior_points;
    if (!points) return [{ category: 'human review points', item: 'human review points', state: 'not verified', detail: NOT_RECORDED }];
    return [
        ...counted('human review points', 'resolved', 'verified', points.resolved ?? 0),
        ...counted('human review points', 'open', 'failed', points.open ?? 0),
        ...counted('human review points', 'to answer in the reply', 'not verified', points.answer_in_reply ?? 0),
    ];
}
