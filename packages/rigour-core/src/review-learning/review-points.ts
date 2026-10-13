/**
 * The points a person makes in a review body: its bullet and numbered lines, each cut to its first line, and its
 * bold and heading blocks (`**1. The window is unbounded**`, `### B3: \`flush\``), each read as its lead and, when
 * the lead alone is short, the first sentence under it. One reader for the backtest's ledger and the learner, so
 * both see the same points.
 */
import { HELP_SUMMARY, plain, sectionOf, sectionReason } from './body-sections.js';
import { asksSomething, type NotRequestReason } from './requests.js';

export const BULLET = /^\s*(?:[-*]|\d+[.)])\s+(.{8,})$/;
const HEADING = /^#{1,6}\s+(.*)$/;
/** A line led by a bold span, and whatever follows it on the line. */
const BOLD_LEAD = /^\*\*(?=\S)(.+?)\*\*(.*)$/;
const FENCE = /^\s*(?:```|~~~)/;
/** A reviewer's own reference on a point: `1.`, `2)`, `B2:`, `#3`. */
const REFERENCE = /^(?:#?[A-Za-z]{0,3}\d+[.):]|\(\d+\))(?:\s+|$)/;
/** A lead that is only an identifier or a path, which says what the point is about but not what it asks. */
const IDENTIFIER = /^`?[\w$./()-]+`?:?$/;
/** A lead shorter than this reads as a title: the first sentence under it is added. */
const SHORT_LEAD = 60;
/** A bold label this short, with a value after it on the line, is a tool's metadata ("Plan: Pro"), not a point. */
const LABEL_WORDS = 4;
const VALUE_WORDS = 6;
/** A value alone: a code span, a hash or id, a number, or one word. */
const VALUE = /^(?:`[^`]*`|[\w.#/-]+)$/;
/** A tool's title: an emoji, then a few words. */
const TOOL_TITLE = /^\p{Extended_Pictographic}/u;
const TITLE_WORDS = 5;
const MAX_POINT = 140;

/** A point of a review body, and why its place in the body makes it ask for nothing (undefined elsewhere). */
export interface BodyPoint {
    text: string;
    place: NotRequestReason | undefined;
}

/** The bullet and numbered lines and the bold and heading blocks of a review body: the points a reviewer makes outside any one line. */
export function bodyPoints(body: string): string[] {
    return readBody(body).map(p => p.text);
}

/**
 * Each point of a review body in order, with its place, by structure: a bullet in the list under a change-summary
 * heading describes the change, one under a praise heading is praise, one under a preamble to what was fixed since
 * the last round is a status report, and a point inside a collapsed block whose summary is about the tool is the
 * tool's own help. A heading or bold line that only names a section (those, or a severity: "Blocking", "Nits"), or
 * that a list or another heading follows, is a section title, not a point.
 */
export function readBody(body: string): BodyPoint[] {
    const lines = body.split('\n');
    const walk: Walk = { lines, points: [], section: undefined, help: false, collapsed: 0, fence: false, joined: false };
    lines.forEach((_, i) => readLine(walk, i));
    return walk.points;
}

/** Where the walk through a body is. */
interface Walk {
    lines: string[];
    points: BodyPoint[];
    /** What the section the walk is in makes of its points. */
    section: NotRequestReason | undefined;
    /** Inside a collapsed block about the review tool itself. */
    help: boolean;
    /** How many collapsed blocks the walk is inside: tools collapse their status and settings, so only bullets count there. */
    collapsed: number;
    fence: boolean;
    /** Inside a block (its lead and the prose straight under it): a bold label there (`**Why:** …`) continues the block. */
    joined: boolean;
}

function readLine(walk: Walk, i: number): void {
    const raw = walk.lines[i];
    const summary = readCollapsed(walk, raw);
    const bullet = BULLET.exec(raw)?.[1];
    if (bullet) return addPoint(walk, firstLine(bullet), walk.section, false);
    const line = raw.replace(/<[^>]+>/g, '').trim();
    if (outsideProse(walk, raw, line) || summary !== undefined) {
        walk.joined = false;
        return;
    }
    const heading = HEADING.exec(line)?.[1];
    const bold = BOLD_LEAD.exec(line);
    if (heading !== undefined) readHeading(walk, heading, i);
    else if (bold) readBoldLead(walk, bold[1], bold[2].replace(/^\s*[:.—–-]?\s*/, ''), i);
    else readPreamble(walk, line, i);
}

/** A collapsed block's summary opens a section, and one about the tool itself is its help, until the block closes. */
function readCollapsed(walk: Walk, raw: string): string | undefined {
    const summary = /<summary>(.*?)<\/summary>/i.exec(raw)?.[1];
    if (summary !== undefined) {
        walk.help = HELP_SUMMARY.test(plain(summary));
        walk.section = sectionReason(sectionOf(summary));
    }
    walk.collapsed = Math.max(0, walk.collapsed + (raw.match(/<details\b/gi)?.length ?? 0) - (raw.match(/<\/details>/gi)?.length ?? 0));
    if (/<\/details>/i.test(raw)) walk.help = false;
    return summary;
}

/** A blank line, markup alone, or code: never a point, and it ends any block. */
function outsideProse(walk: Walk, raw: string, line: string): boolean {
    const fence = FENCE.test(raw);
    if (fence) walk.fence = !walk.fence;
    return fence || walk.fence || !line;
}

function addPoint(walk: Walk, text: string, reason: NotRequestReason | undefined, inBlock: boolean): void {
    walk.points.push({ text, place: walk.help ? 'review tool status' : reason });
    walk.joined = inBlock;
}

/** A heading names a section, or titles the list or heading after it; otherwise it leads a block. */
function readHeading(walk: Walk, heading: string, i: number): void {
    const named = sectionOf(heading);
    const next = nextLine(walk.lines, i);
    walk.section = sectionReason(named);
    walk.joined = false;
    if (!named && !walk.collapsed && !isToolTitle(heading) && next !== undefined && isProse(next)) addPoint(walk, blockText(heading, '', walk.lines, i), undefined, true);
}

/**
 * A bold lead: a section's title when the whole line is bold and names a section, titles what follows or is a tool's
 * title; a tool's metadata when a short label carries a value; else a point. Never a point inside a collapsed block.
 */
function readBoldLead(walk: Walk, span: string, rest: string, i: number): void {
    const labelled = REFERENCE.test(plain(span));
    if (walk.joined && !labelled) return;
    const named = sectionOf(span);
    if (!rest && isBoldTitle(walk, span, named, labelled, i)) {
        walk.section = sectionReason(named);
        walk.joined = false;
        return;
    }
    if (walk.collapsed || isToolValue(span, rest, named, labelled)) {
        walk.joined = false;
        return;
    }
    addPoint(walk, blockText(named ? '' : span, rest, walk.lines, i), leadReason(walk, rest, named), true);
}

/** A tool's setting on one line ("Plan: Pro"): a short label nobody numbered, and a value. */
function isToolValue(span: string, rest: string, named: ReturnType<typeof sectionOf>, labelled: boolean): boolean {
    return !!rest && !labelled && !named && isMetadata(span, rest);
}

/** A section's name as a point's label (`**Nit:** …`) places that point; otherwise the section it sits in does. */
function leadReason(walk: Walk, rest: string, named: ReturnType<typeof sectionOf>): NotRequestReason | undefined {
    return rest && named ? sectionReason(named) ?? walk.section : walk.section;
}

/** Whether a whole bold line titles a section: it names one, sits in a collapsed block, or titles what follows. */
function isBoldTitle(walk: Walk, span: string, named: ReturnType<typeof sectionOf>, labelled: boolean, i: number): boolean {
    return !!named || walk.collapsed > 0 || titlesSection(span, labelled, nextLine(walk.lines, i));
}

/** A plain preamble straight before a list ("Fixed since the last round:") names the list's section. */
function readPreamble(walk: Walk, line: string, i: number): void {
    const next = nextLine(walk.lines, i);
    const named = next !== undefined && BULLET.test(next) ? sectionOf(line) : undefined;
    if (named === 'praise or thanks' || named === 'status report') walk.section = named;
}

/** The first non-empty line after line `i`, trimmed, or undefined at the end of the body. */
function nextLine(lines: string[], i: number): string | undefined {
    return lines.slice(i + 1).map(l => l.trim()).find(Boolean);
}

/** A line of prose: not a list item, a heading, a bold lead, a code fence, a table row or markup. */
function isProse(line: string): boolean {
    return !BULLET.test(line) && !HEADING.test(line) && !BOLD_LEAD.test(line) && !FENCE.test(line) && !/^[<|]/.test(line);
}

/** Whether a whole bold line is a title: a tool's own (an emoji and a few words), a label nothing but markup follows, or by what follows it. */
function titlesSection(span: string, labelled: boolean, next: string | undefined): boolean {
    const text = span.trim();
    if (isToolTitle(text)) return true;
    if (next === undefined) return text.endsWith(':');
    return opensSection(next, labelled) || (text.endsWith(':') && !isProse(next));
}

/** A tool's own title: an emoji and a few words ("🔍 Review summary"). */
function isToolTitle(title: string): boolean {
    return TOOL_TITLE.test(title.trim()) && plain(title).split(' ').length <= TITLE_WORDS;
}

/** A short label and a value: one token, or a few words that end no sentence and ask for nothing ("Plan: Pro Plus"). */
function isMetadata(span: string, rest: string): boolean {
    if (plain(span).split(' ').length > LABEL_WORDS) return false;
    const value = rest.trim();
    if (VALUE.test(value)) return true;
    return value.split(/\s+/).length <= VALUE_WORDS && !/[.!?]$/.test(value) && !asksSomething(value);
}

/** Whether a whole bold line is a section title by what follows it: a list, a heading, markup, or numbered bold points. */
function opensSection(next: string, labelled: boolean): boolean {
    if (BOLD_LEAD.test(next)) return !labelled;
    return !isProse(next);
}

/**
 * A block's point: its lead without the reviewer's reference, and, when the lead is short, a label or an
 * identifier, the first sentence of the prose after it, so the point reads as what the reviewer asked.
 */
function blockText(span: string, rest: string, lines: string[], i: number): string {
    const lead = span.trim().replace(REFERENCE, '').replace(/^[:.—–-]\s*/, '').trim();
    const under = [rest, ...paragraphAfter(lines, i)].filter(Boolean).join(' ');
    const sentence = firstSentence(under);
    const identifier = IDENTIFIER.test(lead);
    if (!lead) return capped(sentence);
    if (!sentence || (plain(lead).length >= SHORT_LEAD && !identifier)) return capped(lead);
    const joiner = /[.!?:]$/.test(lead) ? ' ' : identifier ? ': ' : '. ';
    return capped(`${lead}${joiner}${sentence}`);
}

/** The paragraph under line `i`, past blank lines, bold labels in it included, up to a blank line or the next list, heading, numbered bold lead, fence or markup. */
function paragraphAfter(lines: string[], i: number): string[] {
    const out: string[] = [];
    for (const raw of lines.slice(i + 1)) {
        const line = raw.trim();
        const label = BOLD_LEAD.exec(line)?.[1];
        if (!line && !out.length) continue;
        if (!line || (!isProse(line) && (label === undefined || REFERENCE.test(plain(label))))) break;
        out.push(line);
    }
    return out;
}

/** Text up to its first sentence end, never one inside a code span. */
function firstSentence(text: string): string {
    let code = false;
    for (let i = 0; i < text.length; i++) {
        if (text[i] === '`') code = !code;
        else if (!code && /[.!?]/.test(text[i]) && (i + 1 === text.length || /\s/.test(text[i + 1]))) return text.slice(0, i + 1);
    }
    return text;
}

/** Markdown emphasis off, never the underscores of an identifier (`RESTOCK_CHUNK`) or anything inside a code span. */
export function withoutEmphasis(text: string): string {
    return text.split(/(`[^`]*`)/).map(part => part.startsWith('`') ? part
        : part.replace(/\*+/g, '').replace(/(^|[^\w])__?(?=\S)(.*?\S)__?(?=[^\w]|$)/g, '$1$2')).join('');
}

/** A comment's first non-empty line, heading marks and emphasis removed, at most 140 characters. */
export function firstLine(text: string): string {
    return capped(text.split('\n').find(l => l.trim())?.replace(/^\s*#+\s*/, '') ?? '');
}

/** Emphasis removed, trimmed, at most 140 characters. */
function capped(text: string): string {
    const line = withoutEmphasis(text).trim();
    return line.length > MAX_POINT ? `${line.slice(0, MAX_POINT - 3)}...` : line;
}
