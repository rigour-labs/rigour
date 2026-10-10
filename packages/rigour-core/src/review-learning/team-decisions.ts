/**
 * The decisions this clone received from its team (rigour.review_decisions), and how every reader sees them: folded
 * into the lessons by readLessons. They are kept under the Rigour home, one file per repository, never in the
 * repository's own lessons store: a team may commit `.rigour/review-lessons.json`, and teammates' names and decisions
 * must never reach git history by accident. The store holds what this clone learned and decided; this, what it received.
 *
 * Which decision wins, for each question (state, reach, wording): the latest person decision, ordered by
 *   - a teammate's decision: when the team database received it;
 *   - this person's decision already sent: when the team database received it (`mine`);
 *   - this person's decision this machine will still send (it shares: a listed repository, sme or owner): now, so it
 *     holds until it comes back;
 *   - a decision this machine never sends (a member's, an unlisted repository's): when it was made.
 * Evidence (a later fix, a recurrence) never overrides a person, as in lessonState.
 */
import fs from 'fs';
import path from 'path';
import { repositoryIdSync } from '../storage/repository-origin.js';
import { rigourUserDir } from '../utils/user-state.js';
import type { LessonEvidence, ReviewLesson } from './lessons.js';

export type SharedDecisionKind = 'accepted' | 'rejected' | 'dismissed' | 'scoped' | 'reworded' | 'compiled';
const PERSON_DECISIONS = new Set<string>(['accepted', 'rejected', 'dismissed', 'scoped', 'reworded', 'compiled']);

/** One decision a teammate shared, as this clone keeps it. */
export interface ReceivedDecision {
    /** The team database's row id. */
    id: string;
    lessonId: string;
    kind: SharedDecisionKind;
    /** The decider's display name, set by the team database; absent when the administrator set none. */
    name?: string;
    decidedAt: string;
    receivedAt: string;
    detail: string;
    /** The wording the decision approved. */
    text?: string;
    scope?: 'file' | 'folder' | 'repo';
    /** The lesson's file in this checkout, found from its hash; absent when no tracked file matches. */
    file?: string;
    points: Array<{ pr: number; comment: string; source: 'person' | 'bot' }>;
}

export interface TeamDecisionCache {
    version: 1;
    /** Whether this machine sends its person's decisions for this repository, and if not, why. Written by every sync. */
    sharing: { shares: boolean; person?: string; reason?: string };
    decisions: ReceivedDecision[];
    /** This person's sent decisions, by mineKey, with when the team database received each. */
    mine: Record<string, string>;
}

/** Where a repository's received decisions are kept. */
export function teamDecisionCachePath(repositoryId: string): string {
    return path.join(rigourUserDir(), 'team-decisions', `${repositoryId}.json`);
}

/** A local decision's key in `mine`. */
export function mineKey(lessonId: string, kind: string, comment: string): string {
    return `${lessonId}\u0000${kind}\u0000${comment}`;
}

/** This repository's received decisions, or undefined before its first sync (or without team mode). */
export function readTeamDecisionCache(cwd: string): TeamDecisionCache | undefined {
    try {
        const parsed = JSON.parse(fs.readFileSync(teamDecisionCachePath(repositoryIdSync(cwd)), 'utf8'));
        return parsed?.version === 1 && Array.isArray(parsed.decisions) ? parsed : undefined;
    } catch {
        return undefined;
    }
}

/** Where a person decision falls among the others. */
function orderOf(e: LessonEvidence, lessonId: string, cache: TeamDecisionCache): number {
    if (e.team) return Date.parse(e.team.receivedAt);
    const sent = cache.mine[mineKey(lessonId, e.kind ?? '', e.comment)];
    if (sent) return Date.parse(sent);
    if (cache.sharing.shares && e.author === cache.sharing.person) return Number.MAX_SAFE_INTEGER;
    return Date.parse(e.at ?? '') || 0;
}

/** The latest person decision of these kinds, by order (on a tie, the later in the trail). */
function latest(lesson: ReviewLesson, kinds: string[]): LessonEvidence | undefined {
    return lesson.evidence.filter(e => e.kind && kinds.includes(e.kind)).reduce<LessonEvidence | undefined>((a, b) => (!a || (b.order ?? 0) >= (a.order ?? 0) ? b : a), undefined);
}

/**
 * The stored lessons with the team's decisions folded in: each received decision is evidence on its lesson (a lesson
 * this clone never learned is added from the approved wording), and each question goes to its latest person decision.
 * `state` works out a lesson's state from its evidence (lessonState, passed in so this module needs none of lessons.ts).
 * Pure; the stored lessons are not changed.
 */
export function foldTeamDecisions(stored: ReviewLesson[], cache: TeamDecisionCache, state: (lesson: ReviewLesson) => Pick<ReviewLesson, 'state' | 'promotedBy'>): ReviewLesson[] {
    const lessons = new Map(stored.map(l => [l.id, { ...l, evidence: l.evidence.map(e => ({ ...e })) }]));
    const touched = new Set<string>();
    for (const d of [...cache.decisions].sort((a, b) => a.receivedAt.localeCompare(b.receivedAt) || a.id.localeCompare(b.id))) {
        if (addReceived(lessons, d)) touched.add(d.lessonId);
    }
    for (const id of touched) settle(lessons.get(id)!, cache, state);
    return [...lessons.values()];
}

/** Puts one received decision on its lesson's trail, adding the lesson from its approved wording when this clone never learned it. */
function addReceived(lessons: Map<string, ReviewLesson>, d: ReceivedDecision): boolean {
    let lesson = lessons.get(d.lessonId);
    if (!lesson) {
        // A lesson this clone never learned: only an approved wording makes it something to serve.
        if (d.text === undefined) return false;
        lesson = {
            id: d.lessonId, text: d.text, file: d.file ?? '', symbols: [], state: 'candidate', createdAt: d.decidedAt, updatedAt: d.receivedAt,
            evidence: d.points.map(p => ({ kind: 'point' as const, pr: p.pr, comment: p.comment, author: '', source: p.source })),
        };
        lessons.set(d.lessonId, lesson);
    }
    const comment = `team-${d.id}`;
    if (lesson.evidence.some(e => e.kind === d.kind && e.comment === comment)) return false;
    lesson.evidence.push({
        kind: d.kind, pr: d.points[0]?.pr ?? lesson.evidence[0]?.pr ?? 0, comment, author: '', detail: d.detail, at: d.decidedAt,
        ...(d.text !== undefined ? { text: d.text } : {}),
        team: { name: d.name ?? 'a teammate', receivedAt: d.receivedAt },
    });
    return true;
}

/** A teammate's scope: a file lesson back to its file, or every change (repo) or its folder (a lesson with a file). */
function applyReach(lesson: ReviewLesson, scope: string | undefined): void {
    if (scope === 'file') delete lesson.scope;
    else if (scope === 'repo' || (scope === 'folder' && lesson.file)) lesson.scope = scope;
}

/** Orders a lesson's person decisions, then gives each question (reach, wording, state) to its latest. */
function settle(lesson: ReviewLesson, cache: TeamDecisionCache, state: (lesson: ReviewLesson) => Pick<ReviewLesson, 'state' | 'promotedBy'>): void {
    for (const e of lesson.evidence) if (e.kind && PERSON_DECISIONS.has(e.kind)) e.order = orderOf(e, lesson.id, cache);
    const reach = latest(lesson, ['scoped']);
    if (reach?.team) applyReach(lesson, /^(file|folder|repo)\b/.exec(reach.detail ?? '')?.[1]);
    const wording = latest(lesson, ['reworded']);
    if (wording?.team && wording.text) lesson.text = wording.text;
    Object.assign(lesson, state(lesson));
}
