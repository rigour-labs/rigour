/**
 * Where each string value sits in a JSON text, so one string can be replaced without rewriting the file around it.
 * The text must already parse (JSON.parse); paths are JSON pointers (`/mcpServers/rigour/args/1`).
 */

export function escapeKey(key: string): string {
    return key.replace(/~/g, '~0').replace(/\//g, '~1');
}

/** Each string value's [start, end) offsets in `text`, the quotes included, by its path. */
export function stringSpans(text: string): Map<string, [number, number]> {
    const spans = new Map<string, [number, number]>();
    readValue(text, { i: 0 }, '', spans);
    return spans;
}

function skipSpace(text: string, at: { i: number }): void {
    while (at.i < text.length && /\s/.test(text[at.i])) at.i++;
}

function readString(text: string, at: { i: number }): string {
    const start = at.i++;
    while (text[at.i] !== '"') at.i += text[at.i] === '\\' ? 2 : 1;
    at.i++;
    return JSON.parse(text.slice(start, at.i)) as string;
}

function readValue(text: string, at: { i: number }, path: string, spans: Map<string, [number, number]>): void {
    skipSpace(text, at);
    const c = text[at.i];
    if (c === '"') {
        const start = at.i;
        readString(text, at);
        spans.set(path, [start, at.i]);
    } else if (c === '{' || c === '[') {
        readContainer(text, at, path, spans, c === '{');
    } else {
        while (at.i < text.length && !/[\s,\]}]/.test(text[at.i])) at.i++;
    }
}

function readContainer(text: string, at: { i: number }, path: string, spans: Map<string, [number, number]>, object: boolean): void {
    const close = object ? '}' : ']';
    at.i++;
    skipSpace(text, at);
    for (let n = 0; text[at.i] !== close; n++) {
        let child = `${path}/${n}`;
        if (object) {
            child = `${path}/${escapeKey(readString(text, at))}`;
            skipSpace(text, at);
            at.i++; // the colon
        }
        readValue(text, at, child, spans);
        skipSpace(text, at);
        if (text[at.i] === ',') { at.i++; skipSpace(text, at); }
    }
    at.i++;
}
