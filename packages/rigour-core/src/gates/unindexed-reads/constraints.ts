/**
 * Keys and constraints as CREATE TABLE and ALTER TABLE … ADD write them, read in one place for every check that
 * replays migrations (the index replay in schema.ts, the write contract): PRIMARY KEY, UNIQUE, FOREIGN KEY and
 * EXCLUDE, at table level or on a column, with the name Postgres gives one the DDL leaves unnamed, and whether it is
 * DEFERRABLE.
 */
import { NAME, identifier, mask, parenthesized, splitTopLevel } from './sql.js';

export type ConstraintKind = 'primary key' | 'unique' | 'foreign key' | 'exclude';

export interface Constraint {
    kind: ConstraintKind;
    /** As written, or as Postgres derives it; null when it cannot be derived. */
    name: string | null;
    /** Its columns (a foreign key's own), or null when one is an expression or it adopts an index. */
    columns: string[] | null;
    deferrable: boolean;
    /** `UNIQUE USING INDEX i`: the index it adopts. */
    usingIndex?: string;
}

const TABLE_CONSTRAINT = /^(?:constraint (\S+) )?(primary key|unique|foreign key|exclude)\b(?: nulls (?:not )?distinct)?(?: using (?!index\b)\w+)? ?(?:(\()|using index (\S+))/i;
const COLUMN_CLAUSE = /\b(constraint|not null|null|default|primary key|unique|references|check|generated|collate)\b/gi;
const KINDS: Record<string, ConstraintKind> = { 'primary key': 'primary key', unique: 'unique', references: 'foreign key' };

/** A table-level constraint (`CONSTRAINT k UNIQUE(a, b) DEFERRABLE`), or undefined when the element is not one. */
export function tableConstraint(element: string, table: string): Constraint | undefined {
    const match = TABLE_CONSTRAINT.exec(element);
    if (!match) return undefined;
    const kind = match[2].toLowerCase() as ConstraintKind;
    const written = match[1] ? identifier(match[1]) : undefined;
    if (match[4]) {
        const index = identifier(match[4].split('.').pop()!);
        return { kind, name: written ?? index, columns: null, deferrable: deferrable(element.slice(match[0].length)), usingIndex: index };
    }
    const group = parenthesized(element, match[0].length - 1);
    if (!group) return undefined;
    const columns = constraintColumns(kind, group.inner);
    return { kind, name: written ?? derivedName(table, kind, columns), columns, deferrable: deferrable(element.slice(group.end)) };
}

/** The keys and references a column definition declares; `rest` is the definition after the column's name. */
export function columnConstraints(rest: string, table: string, column: string): Constraint[] {
    const masked = mask(rest);
    const clauses = [...masked.matchAll(COLUMN_CLAUSE)];
    const found: Constraint[] = [];
    let written: string | undefined;
    clauses.forEach((clause, i) => {
        const end = clauses[i + 1]?.index ?? masked.length;
        const keyword = clause[1].toLowerCase();
        const kind = KINDS[keyword];
        if (kind) found.push({ kind, name: written ?? derivedName(table, kind, [column]), columns: [column], deferrable: deferrable(masked.slice(clause.index, end)) });
        written = keyword === 'constraint' ? identifier(rest.slice(clause.index + clause[0].length, end).trim()) : undefined;
    });
    return found;
}

/** The name Postgres gives an unnamed constraint: `t_pkey`, `t_a_b_key`, `t_a_fkey`, `t_a_excl`. */
function derivedName(table: string, kind: ConstraintKind, columns: string[] | null): string | null {
    const bare = table.split('.').pop()!;
    if (kind === 'primary key') return `${bare}_pkey`;
    if (!columns?.length) return null;
    const suffix = kind === 'unique' ? 'key' : kind === 'foreign key' ? 'fkey' : 'excl';
    return `${bare}_${columns.join('_')}_${suffix}`;
}

/** The plain columns of a key list (an EXCLUDE element's column before WITH); null when one is an expression. */
function constraintColumns(kind: ConstraintKind, list: string): string[] | null {
    const pattern = kind === 'exclude' ? new RegExp(String.raw`^(${NAME})(?:\s+\w+_ops)?\s+with\b`, 'i') : new RegExp(String.raw`^(${NAME})$`, 'i');
    const columns = splitTopLevel(list, /,/).map(element => pattern.exec(element)?.[1]);
    return columns.length > 0 && columns.every(c => c !== undefined) ? columns.map(c => identifier(c!)) : null;
}

/** `DEFERRABLE` in what follows a constraint, but not `NOT DEFERRABLE`. */
function deferrable(after: string): boolean {
    return /(?<!\bnot )\bdeferrable\b/i.test(mask(after));
}
