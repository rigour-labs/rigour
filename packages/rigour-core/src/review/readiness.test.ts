import { describe, expect, it } from 'vitest';
import type { Failure } from '../types/index.js';
import type { QualityReceipt } from './receipt.js';
import type { ReviewResult } from './review.js';
import type { ReviewerResult } from './reviewer.js';
import type { ReviewRecord } from './reviewer/record.js';
import { readiness, type ReadinessInput } from './readiness.js';
import { coverageText, readinessLine, readinessMarkdown } from './readiness-render.js';

const finding = { id: 'unused-export', title: 'export f is used nowhere', details: '', files: ['src/a.ts'], line: 1 } as Failure;

const review = (over: Partial<ReviewResult> = {}, summary: Record<string, string> = { 'ast-analysis': 'PASS', 'semantic-bugs': 'PASS', 'migration-order': 'SKIP' }): ReviewResult => ({
    status: 'PASS', findings: [], fileFindings: [], contextFindings: [], advisory: [], muted: 0, dismissed: 0, dismissedByGate: {},
    unlocated: 0, excludedOutsideChangedLines: 0, preexisting: 0, preexistingByCheck: {}, outsideChangeByCheck: {}, changedLines: { 'src/a.ts': new Set([1]) },
    report: { status: 'PASS', failures: [], summary, stats: {} } as never, gateErrors: [], controlFilesChanged: [], hints: [], covered: [], ...over,
});

const receipt: QualityReceipt = { functions: 3, reviewed: 1, changedSinceReview: 0, lowRisk: 1, notCovered: [{ file: 'src/a.ts', function: 'pay', start: 4, score: 4 }], reviewers: {}, otherFiles: 0, setAside: 0 } as QualityReceipt;

const record = (over: Partial<ReviewRecord['verified']> = {}, coverage?: ReviewRecord['coverage']): ReviewRecord => ({
    version: 1, head: 'h', base: 'b', scope: 'full', at: 'now', judges: [],
    verified: { blocking: [], should_fix: [], rules: { served: 3, followed: 2, broken: 0, not_applicable: 1 }, lessons: { served: 2, applied: 0 }, prior_points: { open: 0, resolved: 1, answer_in_reply: 1 }, unverified: 0, notes: 0, disputed: 0, ...over },
    reported: { human_reviews: 1 }, people: { dismissed: 0 }, integrity: 'x', ...(coverage ? { coverage } : {}),
});

const reviewer = (over: Partial<ReviewerResult> = {}): ReviewerResult => ({
    outcome: 'passed', items: [], unverified: [], resolved: [], answerInReply: [], notes: [], advisory: [], disputed: [], dropped: [], dismissed: [],
    reviewers: ['claude'], cached: false, record: record(), ...over,
});

const run = (over: Partial<ReadinessInput> = {}) => readiness({ review: review(), receipt, reviewerRequired: false, ...over });
const DESCRIPTION = 'Adds refunds.\n\n## Done when\n- [ ] a refund over the charge is refused\n- [x] the receipt shows the refund\n';

describe('readiness: technically ready', () => {
    it('is ready on a clean deterministic review, with what did not run as caveats', () => {
        const r = run();
        expect(r.technical).toEqual({ state: 'ready', reasons: [], caveats: ['model review not run', '1 check not run'] });
        expect(r.coverage).toContainEqual({ category: 'checks', item: 'migration-order', state: 'not verified', detail: 'not run' });
        expect(r.coverage).toContainEqual({ category: 'team rules', item: 'team rules', state: 'not verified', detail: 'model review not run' });
        expect(r.coverage).toContainEqual({ category: 'changed units', item: 'src/a.ts:4 pay', state: 'not verified', detail: 'risky, not reviewed' });
        expect(r.coverage).toContainEqual({ category: 'changed units', item: 'low risk', state: 'not verified', count: 1, detail: 'not reviewed' });
    });

    it('is not ready on a blocking finding', () => {
        const r = run({ review: review({ status: 'FAIL', findings: [finding] }, { 'unused-exports': 'FAIL' }) });
        expect(r.technical.state).toBe('not ready');
        expect(r.technical.reasons).toEqual(['1 blocking finding']);
        expect(r.coverage).toContainEqual({ category: 'checks', item: 'unused-exports', state: 'failed' });
    });

    it('is not ready on an open item from the model reviewer', () => {
        const r = run({ reviewer: reviewer({ outcome: 'findings', items: [{ id: 'a', kind: 'finding', class: 'bug', issue: 'x' } as never] }) });
        expect(r.technical).toMatchObject({ state: 'not ready', reasons: ['1 open reviewer item'] });
    });

    it('is unknown when the review is ERROR', () => {
        const r = run({ review: review({ status: 'ERROR', gateErrors: ['typed-checks'] }, { 'typed-checks': 'ERROR' }) });
        expect(r.technical).toMatchObject({ state: 'unknown', reasons: ['could not run: typed-checks'] });
        expect(r.coverage).toContainEqual({ category: 'checks', item: 'typed-checks', state: 'not verified', detail: 'could not run' });
    });

    it('is unknown when the model reviewer is required and unavailable, and the rows it would fill are not verified', () => {
        const r = run({ reviewerRequired: true, reviewer: reviewer({ outcome: 'unavailable', reason: 'claude not installed', record: undefined }) });
        expect(r.technical).toMatchObject({ state: 'unknown', reasons: ['model review required, unavailable (claude not installed)'] });
        expect(r.coverage.filter(row => row.category === 'human review points')).toEqual([{ category: 'human review points', item: 'human review points', state: 'not verified', detail: 'model review unavailable (claude not installed)' }]);
    });

    it('is unknown when the team requires the reviewer and it left changed units unreviewed; a caveat when it does not', () => {
        const partial = reviewer({ record: record({}, { units: 4, accounted: 3, not_reviewed: ['src/a.ts :: close'], not_offered: 0 }) });
        expect(run({ reviewerRequired: true, reviewer: partial }).technical).toMatchObject({ state: 'unknown', reasons: ['model review required, 1 changed unit not reviewed'] });
        const optional = run({ reviewer: partial });
        expect(optional.technical.state).toBe('ready');
        expect(optional.technical.caveats).toContain('1 changed unit not reviewed by the model');
        expect(optional.coverage).toContainEqual({ category: 'changed units', item: 'src/a.ts :: close', state: 'not verified', detail: 'not reviewed by the model' });
    });

    it('fills the table from the reviewer record, and a check that found only notes reads failed, never a pass', () => {
        const r = run({ review: review({}, { 'ast-analysis': 'FAIL' }), reviewer: reviewer({ record: record({ rules: { served: 4, followed: 2, broken: 1, not_applicable: 0 }, lessons: { served: 2, applied: 1 } }) }) });
        expect(r.technical.state).toBe('ready');
        expect(r.technical.caveats).toContain('3 items failed without blocking (see coverage)');
        expect(r.coverage).toEqual(expect.arrayContaining([
            { category: 'checks', item: 'ast-analysis', state: 'failed', detail: 'notes only, never blocking' },
            { category: 'team rules', item: 'followed', state: 'verified', count: 2 },
            { category: 'team rules', item: 'broken', state: 'failed', count: 1 },
            { category: 'team rules', item: 'not answered', state: 'not verified', count: 1 },
            { category: 'lessons', item: 'repeated by this change', state: 'failed', count: 1 },
            { category: 'human review points', item: 'to answer in the reply', state: 'not verified', count: 1 },
        ]));
    });
});

describe('readiness: product ready', () => {
    it('is unknown with no acceptance criteria, saying whether a description was read', () => {
        expect(run().product).toEqual({ state: 'unknown', reasons: ['no acceptance criteria'], caveats: ['no pull request description was read (--pr-body, or a pull request)'] });
        expect(run({ description: 'Fixes a typo.' }).product).toMatchObject({ state: 'unknown', reasons: ['no acceptance criteria'] });
    });

    it('is unknown (not checked) when criteria exist and the goal step did not run, listing each as not verified', () => {
        const r = run({ description: DESCRIPTION });
        expect(r.product).toEqual({ state: 'unknown', reasons: ['not checked'], caveats: ['model review not run'] });
        expect(r.coverage.filter(row => row.category === 'acceptance criteria')).toEqual([
            { category: 'acceptance criteria', item: 'a refund over the charge is refused', state: 'not verified', detail: 'not checked' },
            { category: 'acceptance criteria', item: 'the receipt shows the refund', state: 'not verified', detail: 'not checked' },
        ]);
        expect(run({ description: DESCRIPTION, reviewer: reviewer() }).product.caveats).toEqual(['the goal step did not run (review.goal is off)']);
    });

    it('is ready only when the reviewer recorded every criterion met', () => {
        const goal = [{ item: '[done] a refund over the charge is refused', met: true }, { item: 'the receipt shows the refund', met: true }];
        expect(run({ description: DESCRIPTION, reviewer: reviewer({ goal }) }).product).toEqual({ state: 'ready', reasons: ['2 of 2 criteria met'], caveats: [] });
        const half = run({ description: DESCRIPTION, reviewer: reviewer({ goal: goal.slice(0, 1) }) });
        expect(half.product).toEqual({ state: 'unknown', reasons: ['not checked'], caveats: ['1 of 2 criteria not verified'] });
    });

    it('is not ready on a criterion recorded not met with a quote that checked out; an unchecked "not met" stays not verified', () => {
        const goal = [{ item: 'a refund over the charge is refused', met: false }, { item: 'the receipt shows the refund', met: false }];
        const shown = { id: 'g', kind: 'goal', class: 'goal', issue: "the description's goal is not met: a refund over the charge is refused" } as never;
        const r = run({ description: DESCRIPTION, reviewer: reviewer({ goal, advisory: [shown] }) });
        expect(r.product).toEqual({ state: 'not ready', reasons: ['1 of 2 criteria not met'], caveats: ['1 of 2 criteria not verified'] });
        expect(r.coverage).toContainEqual({ category: 'acceptance criteria', item: 'the receipt shows the refund', state: 'not verified', detail: 'judged not met, but its quote did not check out' });
    });

    it('takes the criteria from the description the reviewer read', () => {
        const r = run({ reviewer: reviewer({ criteria: ['the refund is idempotent'], goal: [{ item: 'the refund is idempotent', met: true }] }) });
        expect(r.product.state).toBe('ready');
    });
});

describe('readiness rendering', () => {
    it('prints the line and the table with every not verified item named', () => {
        const r = run({ description: DESCRIPTION });
        expect(readinessLine(r)).toBe('Technically ready: ready (model review not run; 1 check not run) · Product ready: unknown (not checked; model review not run)');
        const text = coverageText(r).join('\n');
        expect(text).toContain('checks               2 verified · not verified: migration-order (not run)');
        expect(text).toContain('acceptance criteria  not verified: a refund over the charge is refused (not checked), the receipt shows the refund (not checked)');
        expect(text).toContain('changed units        1 verified · not verified: src/a.ts:4 pay (risky, not reviewed), 1 low risk (not reviewed)');
    });

    it('renders markdown with a not verified column that is never empty for what was not checked', () => {
        const md = readinessMarkdown(run()).join('\n');
        expect(md).toContain('**Technically ready: ready (model review not run; 1 check not run) · Product ready: unknown (no acceptance criteria; no pull request description was read (--pr-body, or a pull request))**');
        expect(md).toContain('| checks | 2 | — | migration-order (not run) |');
        expect(md).toContain('| team rules | 0 | — | team rules (model review not run) |');
        expect(md).toContain('| acceptance criteria | 0 | — | — |');
    });

    it('folds a long list into a count that points at the JSON', () => {
        const many = { ...receipt, functions: 9, reviewed: 0, notCovered: Array.from({ length: 8 }, (_, i) => ({ file: 'a.ts', function: `f${i}`, start: i, score: 4 })) } as QualityReceipt;
        expect(coverageText(run({ receipt: many })).join('\n')).toContain('…and 3 more (--json)');
    });
});
