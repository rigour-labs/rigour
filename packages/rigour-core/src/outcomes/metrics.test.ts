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
        const m = outcomeMetrics([record(1, { ci: 'failure', followUps: [fix] }), record(2, { reverted: { sha: 'r', subject: 'Revert' } }), record(3, { settled: false, ci: 'failure' })], [], new Set());
        expect(m.records).toEqual({ merged: 3, settled: 2, unsettled: 1 });
        expect(m.settled.ciRegressed).toEqual({ count: 1, of: 2, rate: null, reason: 'fewer than 10 records: a count, not a rate' });
        expect(m.settled.reverted).toMatchObject({ count: 1, of: 2, rate: null });
        expect(m.settled.fixedLater).toMatchObject({ count: 1, of: 2, rate: null });
    });

    it('counts CI regressions over records with a known CI result, and those without apart', () => {
        const records = Array.from({ length: 10 }, (_, i) => record(i + 1, i === 0 ? { ci: 'failure' } : i < 3 ? { ci: 'unavailable' } : {}));
        const m = outcomeMetrics(records, [], new Set());
        expect(m.settled.ciRegressed).toEqual({ count: 1, of: 8, rate: null, reason: 'fewer than 10 records: a count, not a rate' });
        expect(m.settled.ciUnknown).toBe(2);
        expect(m.settled.fixedLater.of).toBe(10);
    });

    it('gives a rate from ten records on', () => {
        const records = Array.from({ length: 10 }, (_, i) => record(i + 1, i < 3 ? { followUps: [fix] } : {}));
        expect(outcomeMetrics(records, [], new Set()).settled.fixedLater).toEqual({ count: 3, of: 10, rate: 0.3 });
    });

    it('counts pull requests a review by Rigour saw and the rest side by side, each with its own number', () => {
        const m = outcomeMetrics([record(1, { followUps: [fix] }), record(2), record(3, { followUps: [fix] }), record(4, { settled: false })], [], new Set([1, 2, 4]));
        expect(m.settled.reviewed).toEqual({ prs: 2, fixedLater: { count: 1, of: 2, rate: null, reason: expect.any(String) } });
        expect(m.settled.notReviewed).toEqual({ prs: 1, fixedLater: { count: 1, of: 1, rate: null, reason: expect.any(String) } });
    });

    it('counts the lessons waiting on a person, promoted from evidence, dismissed and taken back', () => {
        const m = outcomeMetrics([], [
            lesson('waiting', 'candidate', ['lines']),
            lesson('back', 'candidate', ['reclassified']),
            lesson('taken', 'candidate', ['against', 'against', 'demoted']),
            lesson('promoted', 'verified', ['lines', 'accepted']),
            lesson('dismissed', 'candidate', ['lines', 'dismissed']),
            lesson('plain', 'candidate', []),
        ], new Set());
        expect(m.lessons).toEqual({ awaitingDecision: 3, promotedFromEvidence: 1, dismissed: 1, takenBack: 1 });
        expect(m.version).toBe(1);
    });
});
