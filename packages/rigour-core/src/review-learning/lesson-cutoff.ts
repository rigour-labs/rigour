/**
 * Lessons as they were at a moment: what a backtest's reviewer may know when it replays a review made then. A backtest
 * registers the moment for its worktree (withLessonCutoff); readLessons and lessonsPath (lessons.ts) consult it, so
 * every reader of lessons in that worktree, the checks and the judges' context alike, sees the same past. Outside a
 * backtest nothing is registered and nothing changes.
 *
 * Under a cutoff:
 *   - the store is the worktree's own; RIGOUR_REVIEW_LESSONS, which can point at a file outside it, is not read;
 *   - a lesson created after the moment is left out, and so is one with no creation time (it cannot be shown to have existed);
 *   - a lesson's evidence after the moment is left out, as is evidence with no time unless it only holds a lesson back;
 *     its state, wording and reach are worked out again from what is left;
 *   - a team decision (team-decisions.ts) counts only when it was decided before the moment.
 */
import fs from 'fs';
import path from 'path';
import { foldTeamDecisions, type TeamDecisionCache } from './team-decisions.js';
import type { EvidenceKind, LessonEvidence, ReviewLesson } from './lessons.js';

/** What a cutoff left out, for the backtest's report. */
export interface LessonCutoffReport {
    /** The moment, as an ISO time. */
    at: string;
    /** Lessons a reader got. */
    served: number;
    /** Lessons created after the moment. */
    later: number;
    /** Lessons with no creation time. */
    untimed: number;
    /** Team decisions made after the moment, or with no time. */
    teamLeftOut: number;
}

interface Cutoff { atMs: number; report: LessonCutoffReport }

const cutoffs = new Map<string, Cutoff>();

/** Evidence that only ever holds a lesson back: kept when it has no time, since leaving it out could only serve more. */
const HOLDS_BACK = new Set<EvidenceKind>(['norule', 'counter', 'demoted']);

function key(cwd: string): string {
    try {
        return fs.realpathSync.native(cwd);
    } catch {
        return path.resolve(cwd);
    }
}

/** Runs `work` with the lessons in `cwd` as they were at `at` (an ISO time); the report says what was left out. */
export async function withLessonCutoff<T>(cwd: string, at: string, work: (report: LessonCutoffReport) => Promise<T>): Promise<T> {
    const report: LessonCutoffReport = { at, served: 0, later: 0, untimed: 0, teamLeftOut: 0 };
    const k = key(cwd);
    cutoffs.set(k, { atMs: Date.parse(at), report });
    try {
        return await work(report);
    } finally {
        cutoffs.delete(k);
    }
}

/** Whether lessons read in `cwd` are cut off at a moment. */
export function hasLessonCutoff(cwd: string): boolean {
    return cutoffs.size > 0 && cutoffs.has(key(cwd));
}

/** The lessons as they were at the cutoff registered for `cwd`, the team's decisions folded in; undefined without one. */
export function lessonsAtCutoff(cwd: string, stored: ReviewLesson[], team: TeamDecisionCache | undefined, state: (lesson: ReviewLesson) => Pick<ReviewLesson, 'state' | 'promotedBy'>): ReviewLesson[] | undefined {
    const cutoff = cutoffs.size ? cutoffs.get(key(cwd)) : undefined;
    if (!cutoff) return undefined;
    const report = cutoff.report;
    const decisions = (team?.decisions ?? []).filter(d => before(d.decidedAt, cutoff.atMs));
    report.teamLeftOut = (team?.decisions.length ?? 0) - decisions.length;
    const all = team && decisions.length ? foldTeamDecisions(stored, { ...team, decisions }, state) : stored;
    report.later = 0;
    report.untimed = 0;
    const kept: ReviewLesson[] = [];
    for (const lesson of all) {
        const created = Date.parse(lesson.createdAt ?? '');
        if (Number.isNaN(created)) report.untimed++;
        else if (created > cutoff.atMs) report.later++;
        else {
            const past = lessonAt(lesson, cutoff.atMs, state);
            if (past) kept.push(past);
            else report.untimed++;
        }
    }
    report.served = kept.length;
    return kept;
}

function before(at: string | undefined, atMs: number): boolean {
    const t = Date.parse(at ?? '');
    return !Number.isNaN(t) && t <= atMs;
}

/** One lesson as it stood at the moment, or undefined when none of its evidence can be shown to be from before it. */
function lessonAt(lesson: ReviewLesson, atMs: number, state: (lesson: ReviewLesson) => Pick<ReviewLesson, 'state' | 'promotedBy'>): ReviewLesson | undefined {
    const known = (e: LessonEvidence) => before(e.at ?? e.postedAt, atMs) || (!(e.at ?? e.postedAt) && !!e.kind && HOLDS_BACK.has(e.kind));
    const evidence = lesson.evidence.filter(known);
    if (lesson.evidence.length > 0 && evidence.length === 0) return undefined;
    const later = lesson.evidence.filter(e => !known(e));
    const past: ReviewLesson = { ...lesson, evidence, text: textAt(lesson.text, later), updatedAt: lesson.createdAt };
    delete past.suggestedText;
    delete past.suggestedWhy;
    reachAt(past, later);
    // A state recorded later must not carry over: the evidence left decides it, as lessonState does for any lesson.
    if (evidence.some(e => e.kind)) {
        past.state = 'candidate';
        delete past.promotedBy;
    }
    return { ...past, ...state(past) };
}

/** The wording before the first rewording left out (`<why>; was: <text>`), else the lesson's own. */
function textAt(text: string, later: LessonEvidence[]): string {
    const first = later.find(e => e.kind === 'reworded');
    const was = first?.detail?.split('; was: ')[1];
    return was ?? text;
}

/** The reach the last scoping kept set, or none when every scoping was later. */
function reachAt(lesson: ReviewLesson, later: LessonEvidence[]): void {
    if (!later.some(e => e.kind === 'scoped')) return;
    const scope = lesson.evidence.filter(e => e.kind === 'scoped').at(-1)?.detail?.split(':')[0];
    if (scope === 'repo' || scope === 'folder') lesson.scope = scope;
    else delete lesson.scope;
}
