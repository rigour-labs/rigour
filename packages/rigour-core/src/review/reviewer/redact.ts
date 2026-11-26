/**
 * What leaves a review, with anything Rigour's own secret scanner (hooks/input-validator.ts, the DLP check) or the
 * token shapes it lacks (secret-shapes.ts) find replaced by `[redacted: <kind>]`: what is stored, printed or posted.
 * Every judge, always: a read-only judge can read a home directory too. The judge's raw answer is what Rigour checks
 * quotes against, so a finding on a committed secret stays verified; a stored verdict carries which redacted quotes
 * were confirmed, and a reused one is never matched against the checkout through a redacted quote. Only the count and
 * the kinds leave this file, never a value. JSON is redacted string by string, so it still parses.
 */
import { scanInputForCredentials } from '../../hooks/input-validator.js';
import { secretName } from './judge-env.js';
import { shapeMatches } from './secret-shapes.js';
import type { Verify } from './verdict.js';

export interface Redaction { text: string; count: number }

/** Not a secret, though the scanner reports it: who and where to ssh to. */
const NOT_SECRETS = new Set(['ssh_credentials']);

/** An env-style line is a secret only when its name says so (`PWD=/var/folders/…` is not), or a shape is in its value. */
function secretEnvLine(match: string): boolean {
    return secretName(match.slice(0, match.indexOf('=')).trim());
}

/** Every span to redact in `text` (already normalized), overlapping ones merged into the first. */
function spans(text: string): Array<{ type: string; start: number; end: number }> {
    const scanned = scanInputForCredentials(text, { use_learned_feedback: false }).detections
        .filter(d => d.position && !NOT_SECRETS.has(d.type) && (d.type !== 'env_variable' || secretEnvLine(text.slice(d.position.start, d.position.end))))
        .map(d => ({ type: d.type, start: d.position!.start, end: blockEnd(text, d.type, d.position!.end) }));
    const all = [...scanned, ...shapeMatches(text)].map(span => ({ ...span, end: valueEnd(text, span.end) })).sort((x, y) => x.start - y.start || y.end - x.end);
    const kept: typeof all = [];
    for (const span of all) if (!kept.length || span.start >= kept[kept.length - 1].end) kept.push(span);
    return kept;
}

/** A match that stops inside a value (a pattern's fixed length, `{40}`) runs to the value's end: none of it is left. */
function valueEnd(text: string, end: number): number {
    while (end < text.length && /[A-Za-z0-9/+=_.~-]/.test(text[end])) end++;
    return end;
}

const INVISIBLE = /[\u200B\u200C\u200D\uFEFF\u202A-\u202E\u061C\u2066-\u2069]/;

/**
 * `text` as the scanner reads it (zero-width and bidi characters removed), and where each of its characters is in
 * `text`; no map when NFC changes the text too (then positions cannot be carried back).
 */
function scannable(text: string): { scanned: string; at?: number[] } {
    const at: number[] = [];
    let stripped = '';
    for (let i = 0; i < text.length; i++) {
        if (INVISIBLE.test(text[i])) continue;
        at.push(i);
        stripped += text[i];
    }
    const scanned = stripped.normalize('NFC');
    return scanned === stripped ? { scanned, at } : { scanned };
}

/**
 * `text` with every secret replaced, and how many there were. Invisible characters are removed only inside what is
 * redacted; the rest of the text stays as it was (when NFC would change it, the scanner's text is what is returned).
 */
function redactText(text: string): Redaction {
    const { scanned, at } = scannable(text);
    const found = spans(scanned);
    if (found.length === 0) return { text, count: 0 };
    let out = at ? text : scanned;
    for (const d of [...found].reverse()) {
        const [start, end] = at ? [at[d.start], at[d.end - 1] + 1] : [d.start, d.end];
        out = `${out.slice(0, start)}[redacted: ${d.type}]${out.slice(end)}`;
    }
    return { text: out, count: found.length };
}

/** Where a match ends: a private key's header is what the scanner matches, and the key runs to its END line. */
function blockEnd(text: string, type: string, end: number): number {
    if (type !== 'private_key') return end;
    const footer = /-----END [A-Z ]*PRIVATE KEY-----/.exec(text.slice(end));
    return footer ? end + footer.index + footer[0].length : text.length;
}

/** A parsed JSON value with every string redacted; a string that is itself JSON is redacted inside. */
function redactValue(value: unknown, tally: { count: number }): unknown {
    if (typeof value === 'string') {
        const nested = jsonOf(value);
        if (nested !== undefined) {
            // Re-written only when something inside was redacted: a quote that merely looks like JSON stays byte for byte.
            const inner = { count: 0 };
            const done = redactValue(nested, inner);
            tally.count += inner.count;
            return inner.count ? JSON.stringify(done) : value;
        }
        const done = redactText(value);
        tally.count += done.count;
        return done.text;
    }
    if (Array.isArray(value)) return value.map(v => redactValue(v, tally));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactValue(v, tally)]));
    return value;
}

function jsonOf(text: string): unknown {
    const trimmed = text.trim();
    if (!/^[[{]/.test(trimmed)) return undefined;
    try {
        return JSON.parse(trimmed);
    } catch {
        return undefined;
    }
}

/** A CLI's output: a JSON line is redacted value by value, and each run of other lines as one text (a key spans lines). */
function redactOutput(output: string): Redaction {
    const tally = { count: 0 };
    const out: string[] = [];
    let plain: string[] = [];
    const flush = () => {
        if (plain.length === 0) return;
        const done = redactText(plain.join('\n'));
        tally.count += done.count;
        out.push(done.text);
        plain = [];
    };
    for (const line of output.split('\n')) {
        const parsed = jsonOf(line);
        if (parsed === undefined) {
            plain.push(line);
            continue;
        }
        flush();
        const inner = { count: 0 };
        const done = redactValue(parsed, inner);
        tally.count += inner.count;
        out.push(inner.count ? JSON.stringify(done) : line);
    }
    flush();
    return { text: tally.count ? out.join('\n') : output, count: tally.count };
}

/** A judge's run with its output and errors redacted, and how many values were. */
export function redactRun<T extends { stdout: string; stderr: string }>(run: T): T & { redacted: number } {
    const stdout = redactOutput(run.stdout);
    const stderr = redactOutput(run.stderr);
    return { ...run, stdout: stdout.text, stderr: stderr.text, redacted: stdout.count + stderr.count };
}

/** The caveat a review carries when it redacted any value. */
export function redactionCaveat(count: number): string | undefined {
    return count ? `the judge's answer contained ${count} secret-like value${count === 1 ? '' : 's'}; redacted` : undefined;
}

/** Any value (a verdict, an accounting, a result) with every string in it redacted, and how many values were. */
export function redactDeep<T>(value: T): { value: T; count: number } {
    const tally = { count: 0 };
    const done = redactValue(value, tally) as T;
    return { value: tally.count ? done : value, count: tally.count };
}

const REDACTED = /\[redacted: [a-z0-9_]+\]/;
const quoteKey = (file: string, line: number | undefined, quote: string) => JSON.stringify([file, line ?? null, redactDeep(quote).value]);

/** `verify`, recording each confirmed quote that holds a secret, as it will be stored (redacted): kept with the verdict. */
export function confirmingVerifier(verify: Verify): { verify: Verify; confirmed: () => string[] } {
    const confirmed = new Set<string>();
    return {
        verify: (file, line, quote) => {
            const ok = verify(file, line, quote);
            if (ok && quote !== undefined && redactDeep(quote).count) confirmed.add(quoteKey(file, line, quote));
            return ok;
        },
        confirmed: () => [...confirmed],
    };
}

/** For a stored verdict: a redacted quote is confirmed only when its review confirmed it; any other is checked as ever. */
export function storedVerifier(verify: Verify, confirmed: string[] | undefined): Verify {
    const known = new Set(confirmed ?? []);
    return (file, line, quote) => (quote !== undefined && REDACTED.test(quote) ? known.has(quoteKey(file, line, quote)) : verify(file, line, quote));
}
