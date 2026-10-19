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
    report: { status: 'PASS', failures: [], summary, stats: {} } as never, gateErrors: [], controlFilesChanged: [], hints: [], covered: [], blockingByCheck: {}, ...over,
});

const receipt: QualityReceipt = { functions: 3, reviewed: 1, changedSinceReview: 0, lowRisk: 1, notCovered: [{ file: 'src/a.ts', function: 'pay', start: 4, score: 4 }], reviewers: {}, otherFiles: 0, setAside: 0 } as QualityReceipt;

const record = (over: Partial<ReviewRecord['verified']> = {}, coverage?: ReviewRecord['coverage']): ReviewRecord => ({
    version: 1, head: 'h', base: 'b', scope: 'full', at: '2026-10-19T10:00:00Z', judges: [],
    verified: { blocking: [], should_fix: [], rules: { served: 3, followed: 2, broken: 0, not_applicable: 1 }, lessons: { served: 2, applied: 0 }, prior_points: { open: 0, resolved: 1, answer_in_reply: 1 }, unverified: 0, notes: 0, disputed: 0, ...over },
    reported: { human_reviews: 1 }, people: { dismissed: 0 }, integrity: 'x', ...(coverage ? { coverage } : {}),
});

const reviewer = (over: Partial<ReviewerResult> = {}): ReviewerResult => ({
    outcome: 'passed', items: [], unverified: [], resolved: [], answerInReply: [], notes: [], advisory: [], disputed: [], dropped: [], dismissed: [],
    reviewers: ['claude'], cached: false, record: record(), lessonAnswers: { repeated: 0, notRepeated: 2 }, ...over,
});

const run = (over: Partial<ReadinessInput> = {}) => readiness({ review: review(), receipt, reviewerAsked: false, ...over });
const asked = (over: Partial<ReadinessInput> = {}) => run({ reviewerAsked: true, ...over });
const DESCRIPTION = 'Adds refunds.\n\n## Done when\n- [ ] a refund over the charge is refused\n- [x] the receipt shows the refund\n';
const met = (item: string, checked = true) => ({ item, met: true, checked });
const notMet = (item: string, checked = true) => ({ item, met: false, checked });
const rows = (r: ReturnType<typeof run>, category: string) => r.coverage.filter(row => row.category === category);

describe('readiness: technically ready', () => {
    it('is ready on a clean deterministic review, with what did not run as caveats', () => {
        const r = run();
        expect(r.technical).toEqual({ state: 'ready', reasons: [], caveats: ['model review not run', '1 check not run'] });
        expect(r.coverage).toContainEqual({ category: 'checks', item: 'migration-order', state: 'not verified', detail: 'not run' });
        expect(r.coverage).toContainEqual({ category: 'team rules', item: 'team rules', state: 'not verified', detail: 'model review not run' });
        expect(r.coverage).toContainEqual({ category: 'changed units', item: 'src/a.ts:4 pay', state: 'not verified', detail: 'risky, not reviewed' });
        expect(r.coverage).toContainEqual({ category: 'changed units', item: 'low risk', state: 'not verified', count: 1, detail: 'not reviewed' });
    });

    it('is not ready on a blocking finding, and fails only the check it came from', () => {
        const r = run({ review: review({ status: 'FAIL', findings: [finding], blockingByCheck: { 'unused-exports': 1 } }, { 'unused-exports': 'FAIL', 'ast-analysis': 'FAIL' }) });
        expect(r.technical).toMatchObject({ state: 'not ready', reasons: ['1 blocking finding'] });
        expect(r.coverage).toContainEqual({ category: 'checks', item: 'unused-exports', state: 'failed', detail: '1 blocking finding' });
        expect(r.coverage).toContainEqual({ category: 'checks', item: 'ast-analysis', state: 'noted', detail: 'notes only, never blocking' });
    });

    it('keeps every failed check failed when a blocking finding cannot be tied to its check', () => {
        const r = run({ review: review({ status: 'FAIL', findings: [finding], blockingByCheck: { 'diff-tests': 1 } }, { 'ast-analysis': 'FAIL' }) });
        expect(r.coverage).toContainEqual({ category: 'checks', item: 'ast-analysis', state: 'failed', detail: 'a blocking finding could not be tied to its check' });
    });

    it('is not ready on an open item from the model reviewer', () => {
        const r = asked({ reviewer: reviewer({ outcome: 'findings', items: [{ id: 'a', kind: 'finding', class: 'bug', issue: 'x' } as never] }) });
        expect(r.technical).toMatchObject({ state: 'not ready', reasons: ['1 open reviewer item'] });
    });

    it('is unknown when the review is ERROR', () => {
        const r = run({ review: review({ status: 'ERROR', gateErrors: ['typed-checks'] }, { 'typed-checks': 'ERROR' }) });
        expect(r.technical).toEqual({ state: 'unknown', reasons: ['could not run: typed-checks'], caveats: ['model review not run'] });
        expect(r.coverage).toContainEqual({ category: 'checks', item: 'typed-checks', state: 'not verified', detail: 'could not run' });
    });

    it('says a crashed check that left the status PASS could not run', () => {
        const r = run({ review: review({ gateErrors: ['context-drift'] }, { 'context-drift': 'ERROR', 'semantic-bugs': 'PASS' }) });
        expect(r.technical).toEqual({ state: 'ready', reasons: [], caveats: ['model review not run', '1 check could not run'] });
    });

    it('is unknown only when this run asked for the model review and got no verdict', () => {
        const unavailable = reviewer({ outcome: 'unavailable', reason: 'claude not installed', record: undefined });
        expect(asked({ reviewer: unavailable }).technical).toMatchObject({ state: 'unknown', reasons: ['model review asked for, unavailable (claude not installed)'] });
        expect(asked().technical).toMatchObject({ state: 'unknown', reasons: ['model review asked for, not run'] });
        expect(run().technical.state).toBe('ready');
        expect(rows(asked({ reviewer: unavailable }), 'human review points')).toEqual([{ category: 'human review points', item: 'human review points', state: 'not verified', detail: 'model review unavailable (claude not installed)' }]);
    });

    it('reads a stored verdict on this commit as a caveat, filling the rows from it', () => {
        const r = run({ reviewer: reviewer({ cached: true }) });
        expect(r.technical).toEqual({ state: 'ready', reasons: [], caveats: ['model review from the stored verdict on this commit (2026-10-19T10:00:00Z)', '1 check not run'] });
        expect(r.coverage).toContainEqual({ category: 'team rules', item: 'followed', state: 'verified', count: 2 });
    });

    it('is unknown when this run asked for the reviewer and it left changed units unreviewed; a caveat otherwise', () => {
        const partial = reviewer({ record: record({}, { units: 4, accounted: 3, not_reviewed: ['src/a.ts :: close'], not_offered: 0 }) });
        expect(asked({ reviewer: partial }).technical).toMatchObject({ state: 'unknown', reasons: ['model review asked for, 1 changed unit not reviewed'] });
        const stored = run({ reviewer: partial });
        expect(stored.technical.state).toBe('ready');
        expect(stored.technical.caveats).toContain('1 changed unit not reviewed by the model');
        expect(stored.coverage).toContainEqual({ category: 'changed units', item: 'src/a.ts :: close', state: 'not verified', detail: 'not reviewed by the model' });
    });

    it('notes what never blocks: guidance broken, lessons repeated, notes-only checks; a broken requirement fails', () => {
        const rule = { id: 'r', kind: 'rule', class: 'repo-rule', issue: 'every query is paged' } as never;
        const r = asked({
            review: review({}, { 'ast-analysis': 'FAIL' }),
            reviewer: reviewer({ outcome: 'findings', items: [rule], record: record({ rules: { served: 5, followed: 2, broken: 2, not_applicable: 0 }, lessons: { served: 5, applied: 1 } }), lessonAnswers: { repeated: 1, notRepeated: 2 } }),
        });
        expect(r.technical.caveats).toContain('3 noted');
        expect(r.coverage).toEqual(expect.arrayContaining([
            { category: 'checks', item: 'ast-analysis', state: 'noted', detail: 'notes only, never blocking' },
            { category: 'team rules', item: 'broken', state: 'failed', count: 1, detail: 'a requirement' },
            { category: 'team rules', item: 'broken', state: 'noted', count: 1, detail: 'guidance, never blocks' },
            { category: 'team rules', item: 'not answered', state: 'not verified', count: 1 },
            { category: 'human review points', item: 'to answer in the reply', state: 'not verified', count: 1 },
        ]));
    });

    it('counts a lesson as not repeated only when a judge answered so; the rest are not answered', () => {
        const r = run({ reviewer: reviewer({ record: record({ lessons: { served: 5, applied: 1 } }), lessonAnswers: { repeated: 1, notRepeated: 2 } }) });
        expect(rows(r, 'lessons')).toEqual([
            { category: 'lessons', item: 'not repeated', state: 'verified', count: 2 },
            { category: 'lessons', item: 'repeated by this change', state: 'noted', count: 1 },
            { category: 'lessons', item: 'not answered', state: 'not verified', count: 2 },
        ]);
    });

    it('never crashes on a stored record from before a part existed: that part reads not verified', () => {
        const old = record();
        delete (old.verified as Partial<ReviewRecord['verified']>).rules;
        delete (old.verified as Partial<ReviewRecord['verified']>).lessons;
        delete (old.verified as Partial<ReviewRecord['verified']>).prior_points;
        const r = run({ reviewer: reviewer({ record: old, lessonAnswers: undefined }) });
        expect(rows(r, 'team rules')).toEqual([{ category: 'team rules', item: 'team rules', state: 'not verified', detail: 'not in the stored record' }]);
        expect(rows(r, 'lessons')).toEqual([{ category: 'lessons', item: 'other team lessons', state: 'not verified', detail: 'not in the stored record' }]);
        expect(rows(r, 'human review points')).toEqual([{ category: 'human review points', item: 'human review points', state: 'not verified', detail: 'not in the stored record' }]);
        expect(run({ reviewer: reviewer({ record: { ...record(), verified: undefined } as never }) }).technical.state).toBe('ready');
    });
});

describe('readiness: product ready', () => {
    it('is unknown with no acceptance criteria, saying whether a description was read', () => {
        expect(run().product).toEqual({ state: 'unknown', reasons: ['no acceptance criteria'], caveats: ['no pull request description was read (--pr-body, or a pull request)'] });
        expect(run({ description: 'Fixes a typo.' }).product).toMatchObject({ state: 'unknown', reasons: ['no acceptance criteria'] });
    });

    it('is unknown (not checked) when criteria exist and the goal step did not run, listing each as not verified', () => {
        const r = run({ description: DESCRIPTION });
        expect(r.product).toEqual({ state: 'unknown', reasons: ['not checked'], caveats: ['2 of 2 criteria not verified', 'model review not run'] });
        expect(rows(r, 'acceptance criteria')).toEqual([
            { category: 'acceptance criteria', item: 'a refund over the charge is refused', state: 'not verified', detail: 'not checked' },
            { category: 'acceptance criteria', item: 'the receipt shows the refund', state: 'not verified', detail: 'not checked' },
        ]);
        expect(run({ description: DESCRIPTION, reviewer: reviewer() }).product.caveats).toEqual(['2 of 2 criteria not verified', 'the goal step did not run (review.goal is off)']);
    });

    it('is ready only when every judge that answered shows each criterion met with a quote that checks out', () => {
        const goal = [met('[done] a refund over the charge is refused'), met('the receipt shows the refund')];
        expect(run({ description: DESCRIPTION, reviewer: reviewer({ goal }) }).product).toEqual({ state: 'ready', reasons: ['2 of 2 criteria met'], caveats: [] });
        const half = run({ description: DESCRIPTION, reviewer: reviewer({ goal: goal.slice(0, 1) }) });
        expect(half.product).toEqual({ state: 'unknown', reasons: ['not verified'], caveats: ['1 of 2 criteria not verified'] });
    });

    it('never reads met without evidence as met', () => {
        const r = run({ description: DESCRIPTION, reviewer: reviewer({ goal: [met('a refund over the charge is refused', false), met('the receipt shows the refund'), met('the receipt shows the refund', false)] }) });
        expect(r.product).toEqual({ state: 'unknown', reasons: ['not verified'], caveats: ['2 of 2 criteria not verified'] });
        expect(rows(r, 'acceptance criteria').map(row => row.detail)).toEqual(['no evidence', 'no evidence']);
    });

    it('fails a criterion any judge of a panel shows not met, whatever another judge says', () => {
        const goal = [met('a refund over the charge is refused'), notMet('a refund over the charge is refused'), met('the receipt shows the refund')];
        const r = run({ description: DESCRIPTION, reviewer: reviewer({ goal }) });
        expect(r.product).toEqual({ state: 'not ready', reasons: ['1 of 2 criteria not met'], caveats: [] });
        expect(rows(r, 'acceptance criteria')[0]).toMatchObject({ state: 'failed', detail: 'not met' });
    });

    it('keeps a "not met" whose quote did not check out as not verified', () => {
        const r = run({ description: DESCRIPTION, reviewer: reviewer({ goal: [notMet('a refund over the charge is refused', false), met('the receipt shows the refund')] }) });
        expect(r.product).toEqual({ state: 'unknown', reasons: ['not verified'], caveats: ['1 of 2 criteria not verified'] });
        expect(rows(r, 'acceptance criteria')[0]).toMatchObject({ state: 'not verified', detail: 'judged not met, but its quote did not check out' });
    });

    it('fills a criterion that names a file from the goal check, and says when the goal check did not run', () => {
        const text = '`src/refund.ts` refuses a refund over the charge';
        const description = `## Done when\n- ${text}\n`;
        const goal = { doneWhen: [{ text, paths: ['src/refund.ts'], symbols: [] }], scope: [], outOfScope: [], invariants: [] };
        expect(rows(run({ description }), 'acceptance criteria')).toEqual([{ category: 'acceptance criteria', item: text, state: 'not verified', detail: 'checked by the goal check (not run)' }]);
        expect(run({ description }).product.caveats).toContain('the goal check did not run (review.goal is off, or no description)');
        expect(run({ description, review: review({ goal }) }).product).toMatchObject({ state: 'ready' });
        const missed = { id: 'goal-done-when', title: 'x', details: `The description's "Done when" says: ${text}`, files: [] } as unknown as Failure;
        const failed = run({ description, review: review({ goal, status: 'FAIL', findings: [missed], blockingByCheck: { goal: 1 } }, { goal: 'FAIL' }) });
        expect(failed.product).toMatchObject({ state: 'not ready' });
        expect(rows(failed, 'acceptance criteria')[0]).toMatchObject({ state: 'failed', detail: 'a file it names is not changed (goal check)' });
    });

    it('takes the criteria from the description the reviewer read', () => {
        const r = run({ reviewer: reviewer({ criteria: [{ text: 'the refund is idempotent', paths: [] }], goal: [met('the refund is idempotent')] }) });
        expect(r.product.state).toBe('ready');
    });
});

describe('readiness rendering', () => {
    it('prints the line and the table with every not verified item named', () => {
        const r = run({ description: DESCRIPTION });
        expect(readinessLine(r)).toBe('Technically ready: ready (model review not run; 1 check not run) · Product ready: unknown (not checked; 2 of 2 criteria not verified; model review not run)');
        const text = coverageText(r, 200).join('\n');
        expect(text).toContain('checks               2 verified · not verified: migration-order (not run)');
        expect(text).toContain('changed units        1 verified · not verified: src/a.ts:4 pay (risky, not reviewed), 1 low risk (not reviewed)');
    });

    it('wraps a long row at the width, each part on its own line, nothing dropped', () => {
        const r = run({ description: DESCRIPTION });
        const lines = coverageText(r, 60);
        expect(lines.every(line => line.length <= 60)).toBe(true);
        expect(lines.join(' ').replace(/\s+/g, ' ')).toContain('not verified: a refund over the charge is refused (not checked), the receipt shows the refund (not checked)');
        expect(lines).toContain('                     not verified: migration-order (not run)');
    });

    it('renders markdown with a noted column, a not verified column that is never empty for what was not checked, and more in the report artifact', () => {
        const many = { ...receipt, functions: 9, reviewed: 0, notCovered: Array.from({ length: 8 }, (_, i) => ({ file: 'a.ts', function: `f${i}`, start: i, score: 4 })) } as QualityReceipt;
        const md = readinessMarkdown(run({ receipt: many, review: review({}, { 'ast-analysis': 'FAIL' }) })).join('\n');
        expect(md).toContain('| Coverage | Verified | Failed | Noted | Not verified |');
        expect(md).toContain('| checks | 0 | — | ast-analysis (notes only, never blocking) | — |');
        expect(md).toContain('| team rules | 0 | — | — | team rules (model review not run) |');
        expect(md).toContain("…and 3 more in the JSON report (the job's report artifact)");
        expect(md).not.toContain('--json');
    });
});
