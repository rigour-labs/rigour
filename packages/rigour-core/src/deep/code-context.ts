/**
 * Source context for code-aware review of scoped files.
 *
 * The facts-only prompt gives the model signatures and counts; defects such
 * as an unbounded read, a missing fetch option or a wrong response header
 * live in function bodies. For a scoped run each file is sent with its
 * numbered source. Files over the budget are cut into function/class
 * segments (the ones around changed lines first when a diff is known), and
 * every segment that does not fit is listed as omitted rather than dropped.
 */
import type { FileFacts } from './fact-extractor.js';

export type LineRange = [start: number, end: number];

export interface CodeContext {
    file: string;
    language: string;
    /** Prompt block: header plus numbered source. */
    text: string;
    /** 1-based inclusive line ranges whose source was sent. */
    ranges: LineRange[];
    /** Raw source that was sent, for identifier verification. */
    source: string;
}

export interface CodeContextOptions {
    maxChars: number;
    /** Changed line numbers (from a diff); their enclosing segments go first. */
    focusLines?: number[];
}

export function buildCodeContext(facts: FileFacts, content: string, options: CodeContextOptions): CodeContext {
    const lines = content.split('\n');
    const header = `FILE: ${facts.path} (${facts.language}, ${lines.length} lines)`;
    const whole: LineRange = [1, lines.length];
    const wholeText = renderRange(lines, whole);

    if (header.length + wholeText.length <= options.maxChars) {
        return { file: facts.path, language: facts.language, text: `${header}\n${wholeText}`, ranges: [whole], source: content };
    }

    const segments = orderSegments(segmentsFor(facts, lines.length), options.focusLines);
    const parts: string[] = [header];
    const ranges: LineRange[] = [];
    const omitted: string[] = [];
    let used = header.length;

    for (const segment of segments) {
        const text = renderRange(lines, segment.range);
        const remaining = options.maxChars - used;
        if (text.length <= remaining) {
            parts.push(text);
            ranges.push(segment.range);
            used += text.length + 1;
        } else if (ranges.length === 0 && remaining > 200) {
            const truncated = truncateRange(lines, segment.range, remaining);
            parts.push(truncated.text);
            ranges.push(truncated.range);
            used += truncated.text.length + 1;
        } else {
            omitted.push(`${segment.label} (lines ${segment.range[0]}-${segment.range[1]})`);
        }
    }
    if (omitted.length > 0) parts.push(`… omitted for size: ${omitted.join(', ')}`);

    return {
        file: facts.path,
        language: facts.language,
        text: parts.join('\n'),
        ranges,
        source: ranges.map(([s, e]) => lines.slice(s - 1, e).join('\n')).join('\n'),
    };
}

interface Segment {
    label: string;
    range: LineRange;
}

function segmentsFor(facts: FileFacts, lineCount: number): Segment[] {
    const segments: Segment[] = [
        ...facts.classes.map(c => ({ label: `class ${c.name}`, range: [c.lineStart, c.lineEnd] as LineRange })),
        ...facts.functions.map(f => ({ label: `function ${f.name}`, range: [f.lineStart, f.lineEnd] as LineRange })),
    ]
        .map(s => ({ ...s, range: clampRange(s.range, lineCount) }))
        .sort((a, b) => a.range[0] - b.range[0]);

    // Drop segments nested inside an earlier one (methods inside a class).
    const outer: Segment[] = [];
    for (const segment of segments) {
        const last = outer[outer.length - 1];
        if (last && segment.range[1] <= last.range[1]) continue;
        outer.push(segment);
    }
    return outer.length > 0 ? outer : [{ label: 'file', range: [1, lineCount] }];
}

function orderSegments(segments: Segment[], focusLines?: number[]): Segment[] {
    if (!focusLines || focusLines.length === 0) return segments;
    const touches = (s: Segment) => focusLines.some(l => l >= s.range[0] && l <= s.range[1]);
    return [...segments.filter(touches), ...segments.filter(s => !touches(s))];
}

function clampRange([start, end]: LineRange, lineCount: number): LineRange {
    const s = Math.max(1, Math.min(start, lineCount));
    return [s, Math.max(s, Math.min(end, lineCount))];
}

function renderRange(lines: string[], [start, end]: LineRange): string {
    const width = String(end).length;
    return lines
        .slice(start - 1, end)
        .map((line, i) => `${String(start + i).padStart(width)}| ${line}`)
        .join('\n');
}

function truncateRange(lines: string[], [start, end]: LineRange, maxChars: number) {
    const width = String(end).length;
    const budget = maxChars - 40;
    const kept: string[] = [];
    let used = 0;
    let last = start - 1;
    while (last < end) {
        const rendered = `${String(last + 1).padStart(width)}| ${lines[last]}`;
        if (kept.length > 0 && used + rendered.length + 1 > budget) break;
        kept.push(rendered);
        used += rendered.length + 1;
        last++;
    }
    const omitted = end - last;
    const text = kept.join('\n') + (omitted > 0 ? `\n… [${omitted} lines omitted]` : '');
    return { text, range: [start, last] as LineRange };
}
