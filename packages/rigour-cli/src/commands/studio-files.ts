/** Reading the files Rigour writes, for Studio: read only, and a file that is missing or does not parse reads as nothing. */
import fs from 'fs';

/** A JSON-lines file's records; none when it is missing, and a line that does not parse is skipped. */
export function jsonLines<T>(file: string): T[] {
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
    return text.split('\n').filter(Boolean).flatMap(line => {
        try { return [JSON.parse(line) as T]; } catch { return []; }
    });
}

/** A JSON file's contents, or undefined when it is missing or does not parse. */
export function readJsonFile<T>(file: string): T | undefined {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; } catch { return undefined; }
}

/** A thread line has its time, task and kind; anything else in a thread file is not an event. */
export function isThreadLine(line: unknown): boolean {
    const e = line as { at?: unknown; task?: unknown; kind?: unknown } | null;
    return !!e && typeof e.at === 'string' && typeof e.task === 'string' && typeof e.kind === 'string';
}
