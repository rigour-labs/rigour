import { describe, expect, it } from 'vitest';
import type { PrOutcome } from '../outcomes/outcome.js';
import { applyOutcomeEvidence } from './outcome-evidence.js';
import { lessonState, type LessonEvidence, type ReviewLesson } from './lessons.js';

const point = (pr: number, over: Partial<LessonEvidence> = {}): LessonEvidence => ({ kind: 'point', pr, comment: `c${pr}`, author: `reviewer${pr}`, prAuthor: `author${pr}`, actedOn: false, text: `point ${pr}`, ...over });
function lesson(evidence: LessonEvidence[], file = 'src/job.ts'): ReviewLesson {
    const l: ReviewLesson = { id: 'L1', text: 'take the lock before the first read', file, symbols: [], state: 'candidate', evidence, createdAt: '', updatedAt: '' };
    return Object.assign(l, lessonState(l));
}
function record(pr: number, over: Partial<PrOutcome> = {}): PrOutcome {
    return { pr, mergeSha: `sha${pr}`, mergedAt: '2026-09-01T00:00:00Z', branch: `b${pr}`, author: `author${pr}`, files: ['src/job.ts'], ci: 'success', followUps: [], windowEnd: '2026-10-01T00:00:00Z', settled: true, checkedAt: '2026-10-08T00:00:00Z', ...over };
}
const fix = (file = 'src/job.ts') => ({ sha: 'f1x0000000000000', at: '2026-09-05T00:00:00Z', subject: 'fix: lock first', files: [file], fix: true });
/** Promoted by recurrence: two pull requests, two authors, two reviewers. */
const recurring = () => lesson([point(1), point(2)]);
const none = new Map<number, Set<string>>();

describe('outcome evidence for a lesson', () => {
    it('records a later fix on the point\'s file as followup only: never enough on its own', () => {
        const l = lesson([point(1)]);
        applyOutcomeEvidence([l], [record(1, { followUps: [fix()] })], none, 2);
        expect(l.evidence.map(e => e.kind)).toEqual(['point', 'followup']);
        expect(l.state).toBe('candidate');
    });

    it('promotes on that fix with a second signal: CI failed on the merge commit, or the pull request was reverted', () => {
        for (const second of [{ ci: 'failure' as const }, { reverted: { sha: 'rev0000000000', subject: 'Revert "x" (#1)' } }]) {
            const l = lesson([point(1)]);
            const result = applyOutcomeEvidence([l], [record(1, { followUps: [fix()], ...second })], none, 2);
            expect(l).toMatchObject({ state: 'verified', promotedBy: 'outcome' });
            expect(result.promoted).toEqual(['L1']);
        }
    });

    it('says nothing for a point its pull request acted on, a fix on another file, or a commit that is not a fix', () => {
        const acted = lesson([point(1, { actedOn: true })]);
        const other = lesson([point(1)]);
        const plain = lesson([point(1)]);
        applyOutcomeEvidence([acted], [record(1, { ci: 'failure', followUps: [fix()] })], none, 2);
        applyOutcomeEvidence([other], [record(1, { ci: 'failure', followUps: [fix('src/other.ts')] })], none, 2);
        applyOutcomeEvidence([plain], [record(1, { ci: 'failure', followUps: [{ ...fix(), fix: false, subject: 'tidy up' }] })], none, 2);
        for (const l of [acted, other, plain]) expect(l.evidence.map(e => e.kind)).toEqual(['point']);
    });

    it('adds each piece of evidence once, however often it runs', () => {
        const l = lesson([point(1)]);
        const records = [record(1, { ci: 'failure', followUps: [fix()] })];
        expect(applyOutcomeEvidence([l], records, none, 2).added).toBe(1);
        expect(applyOutcomeEvidence([l], records, none, 2).added).toBe(0);
    });
});

describe('taking a lesson back', () => {
    const applied = (...prs: number[]) => new Map(prs.map(pr => [pr, new Set(['L1'])]));

    it('demotes a lesson recurrence promoted after two independent later pull requests a review found repeating it settled clean', () => {
        const l = recurring();
        expect(l).toMatchObject({ state: 'verified', promotedBy: 'recurrence' });
        const result = applyOutcomeEvidence([l], [record(50), record(51)], applied(50, 51), 2);
        expect(l.state).toBe('candidate');
        expect(l.evidence.filter(e => e.kind === 'against').map(e => e.pr)).toEqual([50, 51]);
        expect(l.evidence.find(e => e.kind === 'demoted')?.detail).toBe('taken back: #50, #51 repeated it and settled clean');
        expect(result.demoted).toEqual(['L1']);
    });

    it('never counts a later pull request that followed the lesson, or one no review checked against it', () => {
        const l = recurring();
        applyOutcomeEvidence([l], [record(50), record(51)], new Map([[50, new Set(['another-lesson'])]]), 2);
        expect(l.state).toBe('verified');
        expect(l.evidence.some(e => e.kind === 'against')).toBe(false);
    });

    it('never counts one that did not settle clean: CI failed, a fix on the lesson\'s file, reverted, or the window still open', () => {
        const l = recurring();
        const records = [
            record(50, { ci: 'failure' }),
            record(51, { followUps: [fix()] }),
            record(52, { reverted: { sha: 'r', subject: 'Revert' } }),
            record(53, { settled: false }),
        ];
        applyOutcomeEvidence([l], records, applied(50, 51, 52, 53), 2);
        expect(l.state).toBe('verified');
    });

    it('needs the pull requests to be independent: one author in one week is not enough, and demote_after raises the bar', () => {
        const same = recurring();
        applyOutcomeEvidence([same], [record(50, { author: 'ana' }), record(51, { author: 'ana' })], applied(50, 51), 2);
        expect(same.state).toBe('verified');
        const weeks = recurring();
        applyOutcomeEvidence([weeks], [record(50, { author: 'ana' }), record(51, { author: 'ana', mergedAt: '2026-09-20T00:00:00Z' })], applied(50, 51), 2);
        expect(weeks.state).toBe('candidate');
        // A day apart, across a week bucket's edge (weeks counted from 1970 start on a Thursday): one author, not a week apart.
        const edge = recurring();
        applyOutcomeEvidence([edge], [record(50, { author: 'ana', mergedAt: '2026-09-09T12:00:00Z' }), record(51, { author: 'ana', mergedAt: '2026-09-10T12:00:00Z' })], applied(50, 51), 2);
        expect(edge.state).toBe('verified');
        const three = recurring();
        applyOutcomeEvidence([three], [record(50), record(51)], applied(50, 51), 3);
        expect(three.state).toBe('verified');
    });

    it('never takes back a lesson a person promoted, and a person promoting it again after it was taken back is final', () => {
        const person = lesson([point(1), { kind: 'accepted', pr: 0, comment: 'yes', author: 'lead' }]);
        applyOutcomeEvidence([person], [record(50), record(51)], applied(50, 51), 2);
        expect(person).toMatchObject({ state: 'verified', promotedBy: 'person' });
        const back = recurring();
        applyOutcomeEvidence([back], [record(50), record(51)], applied(50, 51), 2);
        back.evidence.push({ kind: 'accepted', pr: 0, comment: 'promote again', author: 'lead' });
        Object.assign(back, lessonState(back));
        applyOutcomeEvidence([back], [record(50), record(51), record(52, { author: 'z' })], applied(50, 51, 52), 2);
        expect(back).toMatchObject({ state: 'verified', promotedBy: 'person' });
    });
});
