import { describe, expect, it } from 'vitest';
import type { ReviewLesson } from '../review-learning/lessons.js';
import { outcomeMetrics } from './metrics.js';
import type { PrOutcome } from './outcome.js';

function record(pr: number, over: Partial<PrOutcome> = {}): PrOutcome {
    return { pr, mergeSha: `s${pr}`, mergedAt: '2026-09-01T00:00:00Z', branch: `b${pr}`, author: 'a', files: ['src/a.ts'], ci: 'success', followUps: [], windowEnd: '2026-10-01T00:00:00Z', settled: true, checkedAt: '2026-10-08T00:00:00Z', ...over };
}
const fix = { sha: 'f', at: '2026-09-05T00:00:00Z', subject: 'fix: x', files: ['src/a.ts'], fix: true };
function lesson(id: string, state: ReviewLesson['state'], kinds: string[]): ReviewLesson {
    return { id, text: id, file: 'src/a.ts', symbols: [], state, createdAt: '', updatedAt: '', evidence: [{ kind: 'point', pr: 1, comment: `p-${id}`, author: 'r' }, ...kinds.map((kind, i) => ({ kind, pr: 1, comment: `${kind}-${id}-${i}`, author: '' }))] as ReviewLesson['evidence'] };
}

describe('the outcome numbers', () => {
    it('counts settled records only, and gives no rate below ten records', () => {
        const m = outcomeMetrics([record(1, { ci: 'failure', followUps: [fix] }), record(2, { reverted: { sha: 'r', subject: 'Revert' } }), record(3, { settled: false, ci: 'failure' })], [], new Map());
        expect(m.records).toEqual({ merged: 3, settled: 2, unsettled: 1 });
        expect(m.settled.ciRegressed).toEqual({ count: 1, of: 2, rate: null, reason: 'fewer than 10 records: a count, not a rate' });
        expect(m.settled.reverted).toMatchObject({ count: 1, of: 2, rate: null });
        expect(m.settled.fixedLater).toMatchObject({ count: 1, of: 2, rate: null });
    });

    it('counts CI regressions over records with a known CI result, and those without apart', () => {
        const records = Array.from({ length: 10 }, (_, i) => record(i + 1, i === 0 ? { ci: 'failure' } : i < 3 ? { ci: 'unavailable' } : {}));
        const m = outcomeMetrics(records, [], new Map());
        expect(m.settled.ciRegressed).toEqual({ count: 1, of: 8, rate: null, reason: 'fewer than 10 records: a count, not a rate' });
        expect(m.settled.ciUnknown).toBe(2);
        expect(m.settled.fixedLater.of).toBe(10);
    });

    it('gives a rate from ten records on', () => {
        const records = Array.from({ length: 10 }, (_, i) => record(i + 1, i < 3 ? { followUps: [fix] } : {}));
        expect(outcomeMetrics(records, [], new Map()).settled.fixedLater).toEqual({ count: 3, of: 10, rate: 0.3 });
    });

    it('counts pull requests a review by Rigour saw and the rest side by side, each with its own number', () => {
        const m = outcomeMetrics([record(1, { followUps: [fix] }), record(2), record(3, { followUps: [fix] }), record(4, { settled: false })], [], new Map([1, 2, 4].map(pr => [pr, { usd: 0, earlierBasis: false }])));
        expect(m.settled.reviewed).toEqual({ prs: 2, fixedLater: { count: 1, of: 2, rate: null, reason: expect.any(String) } });
        expect(m.settled.notReviewed).toEqual({ prs: 1, fixedLater: { count: 1, of: 1, rate: null, reason: expect.any(String) } });
    });

    it('counts the model reviewer\'s findings against the checks\' at each first review, and its dollars per pull request', () => {
        const records = [record(1), record(2), record(3), record(4, { settled: false })];
        const m = outcomeMetrics(records, [], new Map([
            [1, { first: { model: 2, checks: 1 }, usd: 1.5, earlierBasis: false }],
            [2, { usd: 0.5, earlierBasis: false }],
            [4, { first: { model: 9, checks: 0 }, usd: 9, earlierBasis: false }],
        ]));
        expect(m.model.share).toEqual({ model: 2, checks: 1, prs: 1, rate: null, reason: 'fewer than 10 pull requests: a count, not a rate' });
        expect(m.model.costPerPr).toEqual({ prs: 2, totalUsd: 2, medianUsd: null, reason: 'fewer than 10 pull requests: a count, not a rate', prsEarlierBasis: 0 });
    });

    it('gives the model share and the median cost from ten reviewed pull requests on', () => {
        const records = Array.from({ length: 10 }, (_, i) => record(i + 1));
        const m = outcomeMetrics(records, [], new Map(records.map((r, i) => [r.pr, { first: { model: i < 3 ? 1 : 0, checks: 1 }, usd: i + 1, earlierBasis: false }])));
        expect(m.model.share).toEqual({ model: 3, checks: 10, prs: 10, rate: 0.23 });
        expect(m.model.costPerPr).toEqual({ prs: 10, totalUsd: 55, medianUsd: 5.5, prsEarlierBasis: 0 });
    });

    it('never pools dollars on the earlier basis: a pull request with an earlier review event is counted apart', () => {
        const m = outcomeMetrics([record(1), record(2), record(3)], [], new Map([
            [1, { usd: 4, earlierBasis: true }], // an event from before every run was counted, and a new one
            [2, { usd: 1, earlierBasis: false }],
            [3, { usd: 2, earlierBasis: false }],
        ]));
        expect(m.model.costPerPr).toMatchObject({ prs: 2, totalUsd: 3, prsEarlierBasis: 1 });
    });

    it('counts the lessons waiting on a person, promoted from evidence, dismissed and taken back', () => {
        const m = outcomeMetrics([], [
            lesson('waiting', 'candidate', ['lines']),
            lesson('back', 'candidate', ['reclassified']),
            lesson('taken', 'candidate', ['against', 'against', 'demoted']),
            lesson('promoted', 'verified', ['lines', 'accepted']),
            lesson('dismissed', 'candidate', ['lines', 'dismissed']),
            lesson('plain', 'candidate', []),
        ], new Map());
        expect(m.lessons).toEqual({ awaitingDecision: 3, promotedFromEvidence: 1, dismissed: 1, takenBack: 1 });
        expect(m.version).toBe(1);
    });
});
