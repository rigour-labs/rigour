/**
 * A JSON config Rigour writes into someone's repository or home, in that file's own style, so a formatter that checks
 * JSON stays green. A change that only replaces string values (a version re-pinned) rewrites just those strings and
 * leaves the rest of the file as it was. Any other change is written in the file's indent (the indent of its first
 * indented line, spaces or a tab; 2 spaces for a file Rigour creates), with a short array of plain values kept on one
 * line, as Prettier's default style keeps it.
 */
import { escapeKey, stringSpans } from './json-spans.js';

/** Prettier's default print width: an array of plain values that fits in it stays on one line. */
const PRINT_WIDTH = 80;

/** The indent a JSON file uses: from its first indented line; 2 spaces when it has none or there is no file yet. */
function jsonIndent(existing?: string): string | number {
    return existing?.match(/\n([ \t]+)\S/)?.[1] ?? 2;
}

/** The JSON text for `value`, in the style of `existing` (2-space indent for a new file), ending with a newline. */
export function jsonText(value: unknown, existing?: string): string {
    const patched = existing === undefined ? undefined : withStringsReplaced(existing, value);
    if (patched !== undefined) return patched;
    return `${inlineShortArrays(JSON.stringify(value, null, jsonIndent(existing)))}\n`;
}

/** Puts each array whose items are all plain values on one line, when that line fits in the print width. */
function inlineShortArrays(text: string): string {
    return text.replace(/\[\n[ \t]*((?:[^[\]{}\n]+\n[ \t]*)+)\]/g, (block: string, body: string, offset: number) => {
        const items = body.split('\n').map(line => line.trim().replace(/,$/, '')).filter(Boolean);
        const inline = `[${items.join(', ')}]`;
        const lineStart = text.lastIndexOf('\n', offset) + 1;
        const lineEnd = text.indexOf('\n', offset + block.length);
        const after = text.slice(offset + block.length, lineEnd === -1 ? undefined : lineEnd);
        const width = columns(text.slice(lineStart, offset)) + columns(inline) + columns(after);
        return width <= PRINT_WIDTH ? inline : block;
    });
}

/** A line's width as Prettier counts it: a tab is 2 columns. */
function columns(text: string): number {
    return text.length + (text.match(/\t/g)?.length ?? 0);
}

/**
 * `existing` with only its changed string values rewritten, or undefined when the change is anything else: keys added,
 * removed or reordered, an array that grew or shrank, a number or boolean that changed, or a file that does not parse.
 */
function withStringsReplaced(existing: string, value: unknown): string | undefined {
    let before: unknown;
    try {
        before = JSON.parse(existing);
    } catch {
        return undefined;
    }
    const changed: Array<{ path: string; text: string }> = [];
    if (!sameShape(before, value, '', changed)) return undefined;
    const spans = stringSpans(existing);
    if (changed.some(change => !spans.has(change.path))) return undefined;
    let out = existing;
    // From the end of the file, so the offsets of earlier strings stay valid.
    for (const { path, text } of changed.sort((a, b) => spans.get(b.path)![0] - spans.get(a.path)![0])) {
        const [start, end] = spans.get(path)!;
        out = out.slice(0, start) + JSON.stringify(text) + out.slice(end);
    }
    return out.endsWith('\n') ? out : `${out}${existing.includes('\r\n') ? '\r\n' : '\n'}`;
}

/** Whether `a` and `b` differ only in string values; each changed string is collected with its path. */
function sameShape(a: unknown, b: unknown, path: string, changed: Array<{ path: string; text: string }>): boolean {
    if (typeof a === 'string' && typeof b === 'string') {
        if (a !== b) changed.push({ path, text: b });
        return true;
    }
    if (Array.isArray(a) || Array.isArray(b)) {
        if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
        return a.every((item, i) => sameShape(item, b[i], `${path}/${i}`, changed));
    }
    if (a && b && typeof a === 'object' && typeof b === 'object') {
        const keysA = Object.keys(a);
        const keysB = Object.keys(b);
        if (keysA.length !== keysB.length || keysA.some((key, i) => key !== keysB[i])) return false;
        const objA = a as Record<string, unknown>;
        const objB = b as Record<string, unknown>;
        return keysA.every(key => sameShape(objA[key], objB[key], `${path}/${escapeKey(key)}`, changed));
    }
    return a === b;
}
