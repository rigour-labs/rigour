/**
 * Just enough SQL lexing to replay Postgres migrations: statements, top-level
 * lists, and identifiers. Anything this cannot read is reported as unknown so
 * the gate stays silent rather than guess.
 */

/** Statements in order, comments removed; a `$tag$ … $tag$` body stays inside its statement. */
export function splitStatements(sql: string): string[] {
    const statements: string[] = [];
    let current = '';
    let i = 0;
    while (i < sql.length) {
        const rest = sql.slice(i);
        const dollar = /^\$[A-Za-z_]*\$/.exec(rest);
        if (rest.startsWith('--')) {
            const end = sql.indexOf('\n', i);
            i = end === -1 ? sql.length : end;
        } else if (rest.startsWith('/*')) {
            const end = sql.indexOf('*/', i + 2);
            i = end === -1 ? sql.length : end + 2;
            current += ' ';
        } else if (dollar) {
            const end = sql.indexOf(dollar[0], i + dollar[0].length);
            const stop = end === -1 ? sql.length : end + dollar[0].length;
            current += sql.slice(i, stop);
            i = stop;
        } else if (sql[i] === "'" || sql[i] === '"') {
            const stop = quotedEnd(sql, i);
            current += sql.slice(i, stop);
            i = stop;
        } else if (sql[i] === ';') {
            if (current.trim()) statements.push(current.trim());
            current = '';
            i++;
        } else {
            current += sql[i++];
        }
    }
    if (current.trim()) statements.push(current.trim());
    return statements.map(s => s.replace(/\s+/g, ' '));
}

/** Index just past a quoted string or identifier starting at `start` (a doubled quote is an escape). */
function quotedEnd(text: string, start: number): number {
    const quote = text[start];
    let i = start + 1;
    while (i < text.length) {
        if (text[i] === quote && text[i + 1] === quote) i += 2;
        else if (text[i] === quote) return i + 1;
        else i++;
    }
    return text.length;
}

/** Split on `separator` outside parentheses and quotes. */
export function splitTopLevel(text: string, separator: RegExp): string[] {
    const parts: string[] = [];
    let depth = 0;
    let start = 0;
    let i = 0;
    while (i < text.length) {
        const ch = text[i];
        if (ch === "'" || ch === '"') { i = quotedEnd(text, i); continue; }
        if (ch === '(') depth++;
        else if (ch === ')') depth--;
        else if (depth === 0) {
            const match = separator.exec(text.slice(i));
            if (match && match.index === 0) {
                parts.push(text.slice(start, i).trim());
                i += match[0].length;
                start = i;
                continue;
            }
        }
        i++;
    }
    parts.push(text.slice(start).trim());
    return parts.filter(Boolean);
}

/** The text inside the parentheses that open at `open`, or undefined when they never close. */
export function parenthesized(text: string, open: number): { inner: string; end: number } | undefined {
    let depth = 0;
    for (let i = open; i < text.length; i++) {
        const ch = text[i];
        if (ch === "'" || ch === '"') { i = quotedEnd(text, i) - 1; continue; }
        if (ch === '(') depth++;
        else if (ch === ')' && --depth === 0) return { inner: text.slice(open + 1, i), end: i + 1 };
    }
    return undefined;
}

/** Strip parentheses that enclose the whole expression, as often as they do: `((a))` → `a`, but `(a) or (b)` stays. */
export function unwrap(text: string): string {
    let current = text.trim();
    while (current.startsWith('(')) {
        const group = parenthesized(current, 0);
        if (!group || group.end !== current.length) break;
        current = group.inner.trim();
    }
    return current;
}

/** A relation name as Rigour keys it: unquoted names fold to lower case, `public.` is implied. */
export function relationName(raw: string): string {
    const parts = raw.split('.').map(identifier);
    if (parts.length === 2 && parts[0] === 'public') return parts[1];
    return parts.join('.');
}

export function identifier(raw: string): string {
    const trimmed = raw.trim();
    return trimmed.startsWith('"') ? trimmed.slice(1, -1).replace(/""/g, '"') : trimmed.toLowerCase();
}

/** One identifier, optionally schema-qualified and quoted: the `name` in `CREATE TABLE name (`. */
export const NAME = String.raw`(?:"(?:[^"]|"")+"|[A-Za-z_][\w$]*)(?:\.(?:"(?:[^"]|"")+"|[A-Za-z_][\w$]*))?`;
