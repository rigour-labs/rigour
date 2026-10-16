/**
 * What the Memory page adds to each lesson's journey, read-only: the lessons Rigour holds that say something different
 * under the same words (core getApplicableLessons), a review lesson's evidence trail (who made the point, at which
 * pull request, who decided and why), and how many lessons agents were given lately.
 */
import { getApplicableLessons, type AgentEvent, type LessonRecord, type ReviewLesson } from '@rigour-labs/core';

const DAY_MS = 24 * 60 * 60 * 1000;

/** One piece of a review lesson's trail, as the Memory page lists it. */
export interface EvidenceItem {
    kind: string;
    pr: number;
    /** Who made the point, or who decided (a git email, or a teammate's display name from the team database). */
    author: string;
    source?: 'person' | 'bot';
    /** Why: the fixing commit, the window, or the reason a person gave. */
    detail?: string;
    at?: string;
    /** Set when the decision came from a teammate through the team database. */
    team?: true;
}

/** A review lesson's evidence, oldest first, without the comment bodies (those stay in the lesson file). */
export function evidenceTrail(lesson: ReviewLesson): EvidenceItem[] {
    return lesson.evidence.map(e => {
        const at = e.postedAt ?? e.at ?? e.team?.receivedAt;
        return {
            kind: e.kind ?? 'point',
            pr: e.pr,
            author: e.team?.name ?? e.author,
            ...(e.source ? { source: e.source } : {}),
            ...(e.detail ? { detail: e.detail } : {}),
            ...(at ? { at } : {}),
            ...(e.team ? { team: true as const } : {}),
        };
    });
}

function describe(lesson: LessonRecord | undefined): string {
    if (!lesson) return 'another lesson';
    const where = lesson.repositoryName ? ` in ${lesson.repositoryName}` : '';
    return `${lesson.visibility === 'team' ? 'a team' : 'a personal'} lesson${where}`;
}

/**
 * Lesson id → the other lessons agents are given with the same words but different evidence. Read from the local
 * store; when it cannot be read, no lesson is said to contradict another.
 */
export async function contradictions(cwd: string): Promise<Map<string, string[]>> {
    const found = new Map<string, string[]>();
    try {
        const { lessons, conflicts } = await getApplicableLessons(cwd);
        const byId = new Map<string, LessonRecord>(lessons.map(l => [l.id, l]));
        for (const conflict of conflicts) {
            for (const id of conflict.lessonIds) {
                found.set(id, conflict.lessonIds.filter(other => other !== id).map(other => describe(byId.get(other))));
            }
        }
    } catch {
        return new Map();
    }
    return found;
}

/** Lessons agents were given in the last `days` days, and in how many requests (a briefing's rules are not lessons). */
export function briefedSince(events: AgentEvent[], now: Date, days: number): { lessons: number; requests: number; days: number } {
    const since = now.getTime() - days * DAY_MS;
    const served = events.filter(e => e.type === 'lessons_served' && Date.parse(e.timestamp ?? '') > since)
        .map(e => (e.lessons?.length ?? 0) - (e.rules ?? 0))
        .filter(n => n > 0);
    return { lessons: served.reduce((n, count) => n + count, 0), requests: served.length, days };
}
