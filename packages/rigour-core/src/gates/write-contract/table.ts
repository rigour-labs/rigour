/** A table's write contract, and the edits a CREATE TABLE or ALTER TABLE ADD makes to it. */
import { identifier, splitTopLevel } from '../unindexed-reads/sql.js';
import { parseColumn, tableCheck, type CheckDef, type Column } from './columns.js';

export interface TableContract {
    columns: Map<string, Column>;
    checks: CheckDef[];
    /** Names of constraints other than CHECKs (keys, foreign keys), so dropping one is understood. */
    constraints: Set<string>;
    /** An EXCLUDE constraint can also arbitrate ON CONFLICT DO NOTHING. */
    exclusion: boolean;
    unknown: boolean;
}

export interface Contracts {
    tables: Map<string, TableContract>;
    /** Enum type → its labels, or null once an ALTER TYPE this does not read touched it. */
    enums: Map<string, string[] | null>;
    /** Domain types: a domain's own NOT NULL and DEFAULT are not read, so columns of one are never judged. */
    domains: Set<string>;
}

/** One element of a CREATE TABLE body (also an ALTER TABLE ADD): a column or a table constraint. */
export function addElement(table: TableContract, element: string, bare: string): void {
    const check = tableCheck(element, bare);
    if (check) {
        table.checks.push(check);
        return;
    }
    const constraint = /^(?:constraint (\S+) )?(primary key|unique|foreign key|exclude)\b(?: nulls (?:not )?distinct)?(?: using \w+)? ?\(([^)]*)\)/i.exec(element);
    if (constraint) return addConstraint(table, bare, constraint);
    if (/^(constraint|primary key|unique|foreign key|exclude|like|check)\b/i.test(element)) {
        table.unknown = true;
        return;
    }
    const column = parseColumn(element, bare);
    if (!column) {
        table.unknown = true;
        return;
    }
    table.columns.set(column.name, column.column);
    table.checks.push(...column.checks);
    for (const name of column.constraints) table.constraints.add(name);
}

/** A table key or foreign key: its name (as written, or as Postgres derives it); a primary key makes its columns NOT NULL. */
function addConstraint(table: TableContract, bare: string, match: RegExpExecArray): void {
    const kind = match[2].toLowerCase();
    const columns = splitTopLevel(match[3], /,/).map(identifier);
    if (kind === 'exclude') table.exclusion = true;
    const suffix = kind === 'primary key' ? null : kind === 'unique' ? 'key' : kind === 'foreign key' ? 'fkey' : 'excl';
    table.constraints.add(match[1] ? identifier(match[1]) : suffix ? `${bare}_${columns.join('_')}_${suffix}` : `${bare}_pkey`);
    if (kind !== 'primary key') return;
    for (const name of columns) {
        const column = table.columns.get(name);
        if (column) column.notNull = true;
    }
}

export function markTable(contracts: Contracts, name: string): void {
    const table = contracts.tables.get(name);
    if (table) table.unknown = true;
}
