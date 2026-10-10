/**
 * Which review points ask for nothing: a review tool's status and scaffolding, a description of what the pull
 * request does, praise and thanks, and status reports. They are not lessons, so learning skips them and counts them
 * ("skipped: not a request").
 *
 * Conservative: a point is skipped only when it matches one of these shapes AND carries no sign of a request (an
 * instruction, a modal, a question, a "but"). When unsure, it is kept.
 */

import { BULLET } from './review-points.js';

/** Why a point is not a request, as counted. */
export type NotRequestReason = 'review tool status' | 'describes the change' | 'praise or thanks' | 'status report';

/** An instruction, a modal, a question or a contrast: any of these and the point is kept. */
const ASKS = /\?|\b(?:should|must|need|needs|could|would|can we|can you|let'?s|please|consider|maybe|might|instead|but|however|why|avoid|don'?t|do not|never|always|make sure|ensure)\b|^(?:use|pick|keep|move|read|filter|check|change|drop|add|remove|pass|split|prefer|replace|rename|derive|select|return|validate|extract|bound|lock|fix|update|document|guard|gate|mark|explain|apply|persist)\b/i;

/** A review tool's own scaffolding: verdict banners, overview headings, review metadata, prompts to rerun it. */
const TOOL_STATUS = /^(?:changes recommended|approval recommended|copilot review overview|pull request overview|review details|file summaries|what changed in this pr|suppressed comments|previously missed|files reviewed:|comments generated:|review effort(?: level)?:|findings:|open \(\d+\)|get a fresh assessment|once you've addressed the issues|learn more in the docs|add a code-review agent skill)/i;

/**
 * A sentence describing what the pull request does, as an overview writes it: a third-person verb first. Only in a
 * review body: on a line, from a person, the same shape states a defect ("Loads every row on each request.").
 */
const DESCRIBES = /^(?:adds|updates|introduces|extends|integrates|restricts|supports|implements|defines|refactors|moves|renames|replaces|improves|enables|exposes|persists|propagates|localizes|guards|tests|covers|documents|applies|uses|reads|builds|creates|loads|renders|styles|provides|preserves|parses|bumps|upgrades|migrates|wires|allows|reworks|simplifies|splits|consolidates)\b/i;

/** Praise and thanks that close or open a review. */
const PRAISE = /^(?:lgtm|looks good|looks great|looks fine|nice|great|thanks|thank you|thx|awesome|well done|good catch|love (?:this|it)|perfect|excellent)\b|\b(?:is|are|looks?) (?:correct|fine|right|good|great|excellent)\b\W*$/i;

/** A report on the state of the pull request rather than a request about its code. */
const STATUS = /\b(?:\d+ tests? (?:pass(?:ing|ed)?|green)|all tests pass(?:ing|ed)?|ci (?:is )?(?:green|passing)|tests? (?:are )?(?:passing|green)|lint (?:went|goes) from|base branch (?:stays|is still)|rebased (?:on|onto)|merged (?:main|master|next) in)\b/i;

/** The point's text with emoji, markdown markers and leading list markup removed, for matching. */
function plain(text: string): string {
    return text
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/[`*_#>]/g, '')
        .replace(/\p{Extended_Pictographic}/gu, '')
        .replace(/^\s*[-•]\s*/, '')
        .replace(/\s+/g, ' ')
        .trim();
}

/** Where a point was made: a comment on lines of code, or a review body (where a tool or the author summarises). */
export type PointPlace = 'inline' | 'body';

/** Whether a point carries a sign of a request: an instruction, a modal, a question, a contrast. */
export function asksSomething(point: string): boolean {
    return ASKS.test(plain(point));
}

/** Why this point asks for nothing, or undefined when it may ask for something (kept). */
export function notARequest(point: string, place: PointPlace): NotRequestReason | undefined {
    const text = plain(point);
    if (!text) return undefined;
    if (TOOL_STATUS.test(text)) return 'review tool status';
    if (asksSomething(text)) return undefined;
    if (STATUS.test(text)) return 'status report';
    if (PRAISE.test(text)) return 'praise or thanks';
    if (place === 'body' && DESCRIBES.test(text)) return 'describes the change';
    return undefined;
}

/**
 * A heading that introduces a summary of the change: what a review tool or the author writes about the pull request.
 * Matched on the heading's own text, so the list under it is a description whatever verbs its bullets start with.
 */
const SUMMARY_HEADING = /^(?:changes|changes made|what changed(?: in this pr)?|summary(?: of changes)?|pull request overview|overview|walkthrough|file summaries)\b/i;
/** A collapsed block a review tool adds about itself: how it works, how to call it. Its list is help, not review. */
const HELP_SUMMARY = /\b(?:about|how to|help|usage|commands|getting started)\b/i;

/**
 * For each bullet point of a review body, in the order bodyPoints returns them, why its place in the body makes it
 * ask for nothing, by structure: a bullet in the list under a change-summary heading describes the change; a bullet
 * inside a collapsed block whose summary is about the tool is the tool's own help. Undefined elsewhere.
 */
export function bodyPointPlaces(body: string): Array<NotRequestReason | undefined> {
    const places: Array<NotRequestReason | undefined> = [];
    let section: NotRequestReason | undefined;
    let help = false;
    for (const raw of body.split('\n')) {
        const summary = /<summary>(.*?)<\/summary>/i.exec(raw)?.[1];
        if (summary !== undefined) help = HELP_SUMMARY.test(plain(summary));
        if (/<\/details>/i.test(raw)) help = false;
        const line = raw.replace(/<[^>]+>/g, '').trim();
        if (BULLET.test(raw)) {
            places.push(help ? 'review tool status' : section);
            continue;
        }
        // A heading or a bold lead line opens a section; the list under a change-summary heading describes the change.
        const heading = /^#{1,6}\s+(.*)$/.exec(line)?.[1] ?? /^\*\*([^*]+)\*\*:?$/.exec(line)?.[1] ?? (summary !== undefined ? summary : undefined);
        if (heading !== undefined) section = SUMMARY_HEADING.test(plain(heading).replace(/:$/, '')) ? 'describes the change' : undefined;
    }
    return places;
}
