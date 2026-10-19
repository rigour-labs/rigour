/**
 * One column as a migration defines it, and the CHECK constraints a write can
 * be held to: NOT NULL, DEFAULT, generated and identity columns, and a CHECK
 * that limits a column to a list of literals (`status IN ('a', 'b')`, or
 * pg_dump's `status = ANY (ARRAY['a'::text, 'b'::text])`). A CHECK of any
 * other shape is kept by name only, so dropping it is understood; it limits
 * nothing this check reports.
 */
import { NAME, identifier, parenthesized, splitTopLevel, unwrap } from '../unindexed-reads/sql.js';

export interface Literal { kind: 'string' | 'number'; text: string }

export interface Column {
    notNull: boolean;
    /** A default other than NULL: serial, identity and `DEFAULT expr` give one. */
    hasDefault: boolean;
    /** `GENERATED ALWAYS AS (…) STORED`: computed, never written. */
    generated: boolean;
    /** The type as written (`text`, `public.order_status`), lower case unless quoted; `[]` kept for arrays. */
    type: string;
}

export interface CheckDef {
    /** The constraint's name, as written or as Postgres derives it; null when it cannot be derived. */
    name: string | null;
    /** The column limited to `values`, when the CHECK is a plain list of literals. */
    column?: string;
    values?: Literal[];
}

export interface ColumnDef { name: string; column: Column; checks: CheckDef[]; constraints: string[] }

const STOP = String.raw`(?:constraint|not null|null|default|primary key|unique|check|references|generated|collate)\b`;
/** A cast, as written or as a dump quotes it: `::text`, `::"text"[]`, `::character varying`. */
const CAST = String.raw`::"?[\w ]+"?(?:\[\])?`;
const SERIAL = /^(small|big)?serial$|^serial[248]$/;

/** `status text NOT NULL DEFAULT 'new' CHECK (…)`, or undefined when it is not a column this reads. */
export function parseColumn(element: string, table: string): ColumnDef | undefined {
    const head = new RegExp(String.raw`^(${NAME})\s+`, 'i').exec(element);
    if (!head) return undefined;
    const name = identifier(head[1]);
    const rest = element.slice(head[0].length);
    const masked = mask(rest);
    const stop = new RegExp(String.raw`(?:^|\s)${STOP}`, 'i').exec(masked);
    const type = normalizeType(rest.slice(0, stop ? stop.index : rest.length));
    if (!type) return undefined;
    const tail = rest.slice(stop ? stop.index : rest.length);
    const maskedTail = masked.slice(stop ? stop.index : rest.length);
    const generated = /\bgenerated always as \(/i.test(maskedTail);
    const identity = /\bgenerated (?:always|by default) as identity\b/i.test(maskedTail);
    const column: Column = {
        notNull: identity || /\b(not null|primary key)\b/i.test(maskedTail) || SERIAL.test(type),
        hasDefault: identity || SERIAL.test(type) || hasDefault(tail, maskedTail),
        generated,
        type,
    };
    return { name, column, checks: columnChecks(tail, maskedTail, table, name), constraints: columnConstraints(maskedTail, tail, table, name) };
}

/** `DEFAULT expr` other than `DEFAULT NULL`, which leaves a NOT NULL column with no usable default. */
export function hasDefault(text: string, masked = mask(text)): boolean {
    const match = new RegExp(String.raw`\bdefault\s+(.*?)(?=\s+${STOP}|$)`, 'i').exec(masked);
    if (!match) return false;
    const start = match.index + match[0].length - match[1].length;
    return !/^\(*null\)*(?:::[\w ]+)?$/i.test(text.slice(start, start + match[1].length).trim());
}

/** A type name: lower case unless quoted, `public.` dropped, its modifiers (`varchar(20)`) dropped. */
export function normalizeType(raw: string): string {
    const trimmed = raw.trim().replace(/\s*\([^)]*\)/g, '');
    const array = /\[\]$|\barray$/i.test(trimmed);
    const base = trimmed.replace(/(\s*\[\])+$|\s+array$/i, '');
    const qualified = new RegExp(String.raw`^${NAME}$`, 'i').test(base) ? base.split('.').map(identifier) : [base.toLowerCase()];
    const name = qualified.length === 2 && qualified[0] === 'public' ? qualified[1] : qualified.join('.');
    return array ? `${name}[]` : name;
}

function columnChecks(tail: string, maskedTail: string, table: string, column: string): CheckDef[] {
    const checks: CheckDef[] = [];
    for (const match of maskedTail.matchAll(/(?:\bconstraint (\S+) )?\bcheck \(/gi)) {
        const body = parenthesized(tail, match.index + match[0].length - 1);
        const list = body ? inList(body.inner) : undefined;
        const named = match[1] ? identifier(tail.slice(match.index + 11, match.index + 11 + match[1].length)) : undefined;
        checks.push({ name: named ?? `${table}_${column}_check`, ...(list ?? {}) });
    }
    return checks;
}

/** Names of the column's other constraints (`references`, `unique`), so `DROP CONSTRAINT` on them is understood. */
function columnConstraints(maskedTail: string, tail: string, table: string, column: string): string[] {
    const names = [...maskedTail.matchAll(/\bconstraint (\S+) (?!check\b)/gi)].map(m => identifier(tail.slice(m.index + 11, m.index + 11 + m[1].length)));
    if (/\breferences\b/i.test(maskedTail)) names.push(`${table}_${column}_fkey`);
    if (/\bunique\b/i.test(maskedTail)) names.push(`${table}_${column}_key`);
    if (/\bprimary key\b/i.test(maskedTail)) names.push(`${table}_pkey`);
    return names;
}

/** A table CHECK: `[CONSTRAINT name] CHECK (expr)`, named as Postgres names it when the list's column is known. */
export function tableCheck(element: string, table: string): CheckDef | undefined {
    const match = /^(?:constraint (\S+) )?check \(/i.exec(element);
    if (!match) return undefined;
    const body = parenthesized(element, match[0].length - 1);
    const list = body ? inList(body.inner) : undefined;
    const name = match[1] ? identifier(match[1]) : list ? `${table}_${list.column}_check` : null;
    return { name, ...(list ?? {}) };
}

/** `col IN ('a', 'b')` or `col = ANY (ARRAY['a', 'b'])`, casts allowed: the column and its allowed literals. */
function inList(expression: string): { column: string; values: Literal[] } | undefined {
    const bare = unwrap(expression);
    const column = String.raw`\(?(${NAME})\)?(?:${CAST})?`;
    const list = new RegExp(String.raw`^${column} in \((.*)\)$`, 'i').exec(bare)
        ?? new RegExp(String.raw`^${column} ?= ?any ?\(\(?array ?\[(.*?)\]\)?(?:${CAST})?\)$`, 'i').exec(bare);
    if (!list) return undefined;
    const values = splitTopLevel(list[2], /,/).map(literal);
    if (values.some(value => value === undefined)) return undefined;
    return { column: identifier(list[1].split('.').pop()!), values: values as Literal[] };
}

/** A SQL literal (`'a''b'::text`, `-3`), or undefined for anything else. */
export function literal(text: string): Literal | undefined {
    const bare = unwrap(text).replace(new RegExp(String.raw`${CAST}$`, 'i'), '');
    const quoted = /^'((?:[^']|'')*)'$/.exec(bare);
    if (quoted) return { kind: 'string', text: quoted[1].replace(/''/g, "'") };
    return /^-?\d+(\.\d+)?$/.test(bare) ? { kind: 'number', text: bare } : undefined;
}

/** The text with what is inside quotes and parentheses blanked (same length), so keywords there are not read as the column's. */
function mask(text: string): string {
    const state: MaskState = { depth: 0, quote: null };
    let out = '';
    for (const ch of text) out += maskChar(state, ch);
    return out;
}

interface MaskState { depth: number; quote: string | null }

/** One character of mask(): kept at the top level and for the parentheses that open and close it, else blanked. */
function maskChar(state: MaskState, ch: string): string {
    const outer = state.depth === 0 && state.quote === null;
    advance(state, ch);
    const closes = ch === ')' && state.depth === 0 && state.quote === null;
    return outer || closes ? ch : ' ';
}

/** Track quotes and parentheses: a quote ends at its own character; parentheses count only outside quotes. */
function advance(state: MaskState, ch: string): void {
    if (state.quote) state.quote = ch === state.quote ? null : state.quote;
    else if (ch === "'" || ch === '"') state.quote = ch;
    else if (ch === '(') state.depth++;
    else if (ch === ')') state.depth--;
}
