/**
 * The two events the learning loop is measured by, written to the same local event log as every
 * agent event: a lesson put in front of an agent, and findings a PR-scope review reported.
 * Studio joins them with stories (stories.ts) to show each lesson's path from where it was
 * learned to whether the same mistake still reaches a PR.
 */
import type { Failure } from '../types/index.js';
import { appendAgentEvent } from './effectiveness.js';

export type LessonChannel = 'recall' | 'context' | 'review';
const MAX_LISTED = 20;

/** Lessons an agent was given before or while writing code. Nothing is written when none were. */
export function recordLessonsServed(cwd: string, via: LessonChannel, subjects: string[]): void {
    const unique = [...new Set(subjects.filter(Boolean))].slice(0, MAX_LISTED);
    if (unique.length) appendAgentEvent(cwd, { type: 'lessons_served', via, lessons: unique });
}

/** Findings a review of a whole branch (what a PR contains) reported. Nothing is written when clean. */
export function recordPrCatches(cwd: string, findings: Failure[]): void {
    if (findings.length === 0) return;
    appendAgentEvent(cwd, {
        type: 'pr_catches',
        findings: findings.slice(0, MAX_LISTED).map(f => ({ rule: f.id, title: f.title, file: f.files?.[0] ?? '' })),
    });
}
