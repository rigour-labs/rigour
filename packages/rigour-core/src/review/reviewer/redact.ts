/**
 * A judge's raw output, with anything Rigour's own secret scanner (hooks/input-validator.ts, the DLP check) finds
 * replaced by `[redacted: <kind>]`, before any of it is parsed, stored, printed or posted. Every judge, always: a
 * read-only judge can read a home directory too. Only the count and the kinds leave this file, never a value.
 * JSON is redacted string by string (a JSON answer inside a JSON event too), so the answer still parses.
 */
import { scanInputForCredentials } from '../../hooks/input-validator.js';

export interface Redaction { text: string; count: number }

/** `text` with every secret the scanner is sure enough to act on (block or warn) replaced, and how many there were. */
function redactText(text: string): Redaction {
    const found = scanInputForCredentials(text, { use_learned_feedback: false }).detections.filter(d => d.position);
    if (found.length === 0) return { text, count: 0 };
    // The scanner reads the text with zero-width and bidi characters removed: its positions are in that text.
    let out = text.replace(/[​‌‍﻿]/g, '').replace(/[‪-‮؜⁦-⁩]/g, '').normalize('NFC');
    for (const d of [...found].sort((a, b) => b.position!.start - a.position!.start)) {
        out = `${out.slice(0, d.position!.start)}[redacted: ${d.type}]${out.slice(blockEnd(out, d.type, d.position!.end))}`;
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
