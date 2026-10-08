/**
 * What the outcome records (outcomes/outcome.ts) say about the team's review lessons. Deterministic, and a person's
 * decision always wins (lessonState).
 *
 * For a lesson: a point its pull request did not act on, whose own lines (within three either side, followed through
 * every later commit as code moves: outcomes.ts outcomeFor) a later commit inside the record's window changed, where
 * that commit says it fixed something and touches at most fifteen files (a broad sweep says nothing about one point):
 * an `outcome`, and the point was right. CI regressing on the merge commit, or the pull request being reverted, is
 * recorded with it as context, never the trigger: they say the pull request was wrong somewhere, not that this point
 * was. A fix that touched only the point's file is `followup` evidence, never enough on its own.
 *
 * Against a lesson: only when a review of a later pull request recorded the lesson as APPLYING (the change does what the
 * lesson warns against; the reviewer's lessons step, review event `lessons_applied`) and the pull request merged anyway
 * and settled clean: CI passed on the merge commit, no fix touched the lesson's file in the window, and no revert. A
 * pull request that followed the lesson, or that no review checked against it, never counts. `demote_after` such pull
 * requests, independent (more than one author, or merged at least a week apart), take back a lesson evidence promoted
 * (by an outcome or by recurrence): it is `demoted` to a candidate. A lesson a person promoted, or corrected into being,
 * is not.
 */
import type { PrOutcome } from '../outcomes/outcome.js';
import type { Git } from './acted-on.js';
import { lessonState, type LessonEvidence, type ReviewLesson } from './lessons.js';
import { outcomeFor } from './outcomes.js';

/** Lines either side of a point's own that count as its lines, and the most files a fixing commit may touch to say anything about one point. */
const POINT_SLACK = 3;
const MAX_FIX_FILES = 15;

export interface OutcomeEvidenceOptions {
    demoteAfter: number;
    /** git in the repository, and its main branch: without them, no lines can be followed and nothing is promoted. */
    git?: Git;
    mainRef?: string;
    /** Stop following lines at this time (ms since epoch); what was found is kept. */
    deadline?: number;
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export interface OutcomeEvidenceResult { added: number; promoted: string[]; demoted: string[] }

/**
 * Adds the evidence the settled and unsettled records give, to `lessons` in place, once each (by its comment key), and
 * recomputes their states. `applied` is, per pull request, the lessons a review of it recorded as applying.
 */
export function applyOutcomeEvidence(lessons: ReviewLesson[], records: PrOutcome[], applied: Map<number, Set<string>>, options: OutcomeEvidenceOptions): OutcomeEvidenceResult {
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
        // For it: a point its pull request left alone, whose own lines a later fix inside the window changed.
        for (const point of lesson.evidence.filter(e => (e.kind ?? 'point') === 'point' && e.actedOn === false)) {
            const record = byPr.get(point.pr);
            // Only where the record shows a fix on the file at all: following lines costs a git walk, done only then.
            const fileFix = lesson.file ? record?.followUps.find(f => f.fix && f.files.includes(lesson.file)) : undefined;
            if (!record || !fileFix) continue;
            const context = [record.ci === 'failure' ? 'CI regressed on the merge commit' : '', record.reverted ? `the pull request was reverted by ${record.reverted.sha.slice(0, 9)}` : ''].filter(Boolean).join('; ');
            const inTime = options.deadline === undefined || Date.now() <= options.deadline;
            const lines = options.git && options.mainRef && lesson.at && inTime
                ? outcomeFor(options.git, lesson, { number: record.pr, mergeSha: record.mergeSha, mergedAt: record.mergedAt }, { mainRef: options.mainRef, until: record.windowEnd, slack: POINT_SLACK, maxFiles: MAX_FIX_FILES })
                : undefined;
            if (lines?.kind === 'outcome') add({ ...lines, detail: `${lines.detail}${context ? `; ${context}` : ''}` });
            else add({ kind: 'followup', pr: record.pr, comment: `followup-${record.pr}-${fileFix.sha.slice(0, 12)}`, author: '', detail: `${lesson.file} fixed later by ${fileFix.sha.slice(0, 9)} "${fileFix.subject}", not on the point's lines${context ? `; ${context}` : ''}`, at: fileFix.at });
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
            if (new Set(against.map(e => e.pr)).size >= options.demoteAfter && (authors > 1 || apart)) {
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
