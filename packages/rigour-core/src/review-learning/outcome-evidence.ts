/**
 * What the outcome records (outcomes/outcome.ts) say about the team's review lessons. Deterministic, and a person's
 * decision always wins (lessonState).
 *
 * For a lesson: a point it came from that its pull request did not act on, then a later fix on the point's file, is
 * `followup` evidence on its own (a "fix typo" touches a file too). With a second signal, the merge commit's CI failing
 * or the pull request reverted, it is an `outcome`: the point was right.
 *
 * Against a lesson: only when a review of a later pull request recorded the lesson as APPLYING (the change does what the
 * lesson warns against; the reviewer's lessons step, review event `lessons_applied`) and the pull request merged anyway
 * and settled clean: CI passed on the merge commit, no fix touched the lesson's file in the window, and no revert. A
 * pull request that followed the lesson, or that no review checked against it, never counts. `demote_after` such pull
 * requests, independent (more than one author, or merged at least a week apart), take back a lesson evidence promoted (by an
 * outcome or by recurrence): it is `demoted` to a candidate. A lesson a person promoted, or corrected into being, is not.
 */
import type { PrOutcome } from '../outcomes/outcome.js';
import { lessonState, type LessonEvidence, type ReviewLesson } from './lessons.js';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export interface OutcomeEvidenceResult { added: number; promoted: string[]; demoted: string[] }

/**
 * Adds the evidence the settled and unsettled records give, to `lessons` in place, once each (by its comment key), and
 * recomputes their states. `applied` is, per pull request, the lessons a review of it recorded as applying.
 */
export function applyOutcomeEvidence(lessons: ReviewLesson[], records: PrOutcome[], applied: Map<number, Set<string>>, demoteAfter: number): OutcomeEvidenceResult {
    const byPr = new Map(records.map(r => [r.pr, r]));
    const result: OutcomeEvidenceResult = { added: 0, promoted: [], demoted: [] };
    for (const lesson of lessons) {
        const before = lesson.state;
        const add = (evidence: LessonEvidence) => {
            if (lesson.evidence.some(e => e.comment === evidence.comment)) return;
            lesson.evidence.push(evidence);
            result.added++;
        };
        const own = new Set(lesson.evidence.filter(e => (e.kind ?? 'point') === 'point').map(e => e.pr));
        // For it: a point its pull request left alone, then a fix on its file.
        for (const point of lesson.evidence.filter(e => (e.kind ?? 'point') === 'point' && e.actedOn === false)) {
            const record = byPr.get(point.pr);
            const fix = lesson.file ? record?.followUps.find(f => f.fix && f.files.includes(lesson.file)) : undefined;
            if (!record || !fix) continue;
            const second = record.ci === 'failure' ? 'CI failed on the merge commit' : record.reverted ? `the pull request was reverted by ${record.reverted.sha.slice(0, 9)}` : undefined;
            add(second
                ? { kind: 'outcome', pr: record.pr, comment: `outcome-file-${record.pr}-${fix.sha.slice(0, 12)}`, author: '', detail: `${lesson.file} fixed later by ${fix.sha.slice(0, 9)} "${fix.subject}", and ${second}`, at: fix.at }
                : { kind: 'followup', pr: record.pr, comment: `followup-${record.pr}-${fix.sha.slice(0, 12)}`, author: '', detail: `${lesson.file} fixed later by ${fix.sha.slice(0, 9)} "${fix.subject}"; no second signal`, at: fix.at });
        }
        // Against it: later pull requests a review found repeating it, merged anyway, settled clean.
        if (lesson.state === 'verified' && (lesson.promotedBy === 'outcome' || lesson.promotedBy === 'recurrence')) {
            for (const [pr, ids] of applied) {
                const record = byPr.get(pr);
                if (own.has(pr) || !ids.has(lesson.id) || !record || !settledClean(record, lesson.file)) continue;
                add({ kind: 'against', pr, comment: `against-${pr}`, author: '', prAuthor: record.author, detail: `a review found #${pr} repeating it; merged ${record.mergedAt.slice(0, 10)}, CI passed, no fix on ${lesson.file || 'its files'} within the window, no revert`, at: record.mergedAt });
            }
            const against = lesson.evidence.filter(e => e.kind === 'against');
            const authors = new Set(against.map(e => e.prAuthor).filter(Boolean)).size;
            // Independent: more than one author, or merged at least a week apart (a span, never calendar buckets: two merges a day apart across a week boundary are not).
            const times = against.map(e => Date.parse(e.at ?? '')).filter(Number.isFinite);
            const apart = times.length > 1 && Math.max(...times) - Math.min(...times) >= WEEK_MS;
            if (new Set(against.map(e => e.pr)).size >= demoteAfter && (authors > 1 || apart)) {
                add({ kind: 'demoted', pr: against.at(-1)!.pr, comment: `demoted-${against.map(e => e.pr).sort((a, b) => a - b).join('-')}`, author: '', detail: `taken back: ${against.map(e => `#${e.pr}`).join(', ')} repeated it and settled clean`, at: new Date().toISOString() });
            }
        }
        Object.assign(lesson, lessonState(lesson));
        if (lesson.state !== before) (lesson.state === 'verified' ? result.promoted : result.demoted).push(lesson.id);
    }
    return result;
}

/** CI passed on the merge commit, no fix touched the file (any file, for a team standard) within the window, no revert. Settled only. */
function settledClean(record: PrOutcome, file: string): boolean {
    return record.settled && record.ci === 'success' && !record.reverted && !record.followUps.some(f => f.fix && (!file || f.files.includes(file)));
}
