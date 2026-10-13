/**
 * The sections of a review body, by the words of the heading, bold line or preamble that opens them. A section
 * name is never a point itself; it says what the points under it are.
 */

import type { NotRequestReason } from './requests.js';

/** The point's text with emoji, markdown markers and leading list markup removed, for matching. */
export function plain(text: string): string {
    return text
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/[`*_#>]/g, '')
        .replace(/\p{Extended_Pictographic}/gu, '')
        .replace(/^\s*[-•]\s*/, '')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * A heading that introduces a summary of the change: what a review tool or the author writes about the pull request.
 * Matched on the heading's own text, so the list under it is a description whatever verbs its bullets start with.
 */
const SUMMARY_HEADING = /^(?:changes|changes made|what changed(?: in this pr)?|summary(?: of changes)?|pull request overview|overview|walkthrough|file summaries)\b/i;
/** A collapsed block a review tool adds about itself: how it works, how to call it. Its list is help, not review. */
export const HELP_SUMMARY = /\b(?:about|how to|help|usage|commands|getting started)\b/i;
/** A section of what the reviewer liked: its points are praise, whatever their verbs. */
const PRAISE_HEADING = /^(?:what'?s good|what is good|what (?:i|we) liked|what works(?: well)?|strengths|positives|nice work|good work|the good(?: parts)?|highlights)$/i;
/** A preamble to what the author fixed or addressed since the last round: its points report, they do not ask. */
const STATUS_HEADING = /^(?:(?:fixed|addressed|resolved|done|changes|changed|what changed)\s+(?:since|in this (?:round|revision|update)|from (?:the )?(?:last|previous))\b.*|fixed|addressed|resolved|since (?:the )?(?:last|previous) (?:round|review)\b.*)$/i;
/** A severity section: its points are requests, at that severity. */
const SEVERITY_HEADING = /^(?:blocking|blockers?|non[- ]?blocking|must[- ]?fix|should[- ]?fix|nits?|nitpicks?|minor|major|optional|suggestions?|questions?)(?:\s+(?:issues?|items?|points?|comments?|changes))?$/i;

/** What a section's name says of the points under it: why they ask for nothing, `severity`, or undefined when it names no section. */
export function sectionOf(title: string): NotRequestReason | 'severity' | undefined {
    const text = plain(title).replace(/\(\d+\)/g, '').replace(/[:.]+$/, '').replace(/\s+/g, ' ').trim();
    if (STATUS_HEADING.test(text)) return 'status report';
    if (PRAISE_HEADING.test(text)) return 'praise or thanks';
    if (SUMMARY_HEADING.test(text)) return 'describes the change';
    if (SEVERITY_HEADING.test(text)) return 'severity';
    return undefined;
}

/** Why a section's points ask for nothing: never for a severity section, whose points are requests. */
export function sectionReason(named: NotRequestReason | 'severity' | undefined): NotRequestReason | undefined {
    return named === 'severity' ? undefined : named;
}
