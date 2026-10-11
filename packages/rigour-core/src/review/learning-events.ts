/**
 * The two events the learning loop is measured by, written to the same local event log as every
 * agent event: a lesson put in front of an agent, and findings a PR-scope review reported.
 * Studio joins them with stories (stories.ts) to show each lesson's path from where it was
 * learned to whether the same mistake still reaches a PR.
 */
import type { Failure } from '../types/index.js';
import { appendAgentEvent } from './effectiveness.js';
import { countUsage } from '../telemetry/telemetry.js';
import { telemetryCheckId } from '../telemetry/check-ids.js';

export type LessonChannel = 'recall' | 'context' | 'review' | 'brief';
const MAX_LISTED = 20;

/**
 * Lessons (and, from a briefing, rules) an agent was given before or while writing code. `ids` and `files` say which items
 * and for which files, when the channel knows them (a briefing). Nothing is written when none were.
 */
export function recordLessonsServed(cwd: string, via: LessonChannel, subjects: string[], detail: { ids?: string[]; files?: string[]; rules?: number } = {}): void {
    const unique = [...new Set(subjects.filter(Boolean))].slice(0, MAX_LISTED);
    if (!unique.length) return;
    appendAgentEvent(cwd, {
        type: 'lessons_served', via, lessons: unique,
        ...(detail.ids?.length ? { ids: detail.ids.slice(0, MAX_LISTED) } : {}),
        ...(detail.files?.length ? { files: detail.files.slice(0, MAX_LISTED) } : {}),
        ...(detail.rules ? { rules: detail.rules } : {}),
    });
}

/** Findings a review of a whole branch (what a PR contains) reported. Nothing is written when clean. */
export function recordPrCatches(cwd: string, findings: Failure[]): void {
    if (findings.length === 0) return;
    // A finding that reached a pull request's review: counted for opt-in telemetry by its gate id only, if one of Rigour's own.
    for (const finding of findings) countUsage(`finding_pushed:${telemetryCheckId(finding.id)}`);
    appendAgentEvent(cwd, {
        type: 'pr_catches',
        findings: findings.slice(0, MAX_LISTED).map(f => ({ rule: f.id, title: f.title, file: f.files?.[0] ?? '' })),
    });
}

/** The agent was about to write something that already exists, and was pointed to it. */
export function recordReuseSuggested(cwd: string, planned: string, existing: string, action: 'BLOCK' | 'WARN'): void {
    appendAgentEvent(cwd, { type: 'reuse_suggested', planned, existing, action });
}
