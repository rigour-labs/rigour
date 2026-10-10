/**
 * Which review points ask for nothing: a review tool's status and scaffolding, a description of what the pull
 * request does, praise and thanks, and status reports. They are not lessons, so learning skips them and counts them
 * ("skipped: not a request").
 *
 * Conservative: a point is skipped only when it matches one of these shapes AND carries no sign of a request (an
 * instruction, a modal, a question, a "but"). When unsure, it is kept.
 */

/** Why a point is not a request, as counted. */
export type NotRequestReason = 'review tool status' | 'describes the change' | 'praise or thanks' | 'status report';

/** An instruction, a modal, a question or a contrast: any of these and the point is kept. */
const ASKS = /\?|\b(?:should|must|need|needs|could|would|can we|can you|let'?s|please|consider|maybe|might|instead|but|however|why|avoid|don'?t|do not|never|always|make sure|ensure)\b|^(?:use|pick|keep|move|read|filter|check|change|drop|add|remove|pass|split|prefer|replace|rename|derive|select|return|validate|extract|bound|lock|fix|update|document|guard|gate|mark|explain|apply|persist)\b/i;

/** A review tool's own scaffolding: verdict banners, overview headings, review metadata, prompts to rerun it. */
const TOOL_STATUS = /^(?:changes recommended|approval recommended|copilot review overview|pull request overview|review details|file summaries|what changed in this pr|suppressed comments|previously missed|files reviewed:|comments generated:|review effort(?: level)?:|findings:|open \(\d+\)|get a fresh assessment|once you've addressed the issues|learn more in the docs|add a code-review agent skill)/i;

/** A sentence describing what the pull request does, as an overview writes it: a third-person verb first. */
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

/** Why this point asks for nothing, or undefined when it may ask for something (kept). */
export function notARequest(point: string): NotRequestReason | undefined {
    const text = plain(point);
    if (!text) return undefined;
    if (TOOL_STATUS.test(text)) return 'review tool status';
    if (ASKS.test(text)) return undefined;
    if (STATUS.test(text)) return 'status report';
    if (PRAISE.test(text)) return 'praise or thanks';
    if (DESCRIBES.test(text)) return 'describes the change';
    return undefined;
}
