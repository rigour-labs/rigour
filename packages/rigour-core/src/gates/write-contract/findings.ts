/**
 * What the database will do with a write, judged against the table's contract:
 *
 * (a) a NOT NULL column with no default that no row sets: rejected;
 * (b) a bulk write whose rows set different keys: supabase-js sends a key
 *     missing from a row as NULL (unless `defaultToNull: false`, which sends
 *     the column's default), so a NOT NULL column gets NULL: rejected;
 * (c) a literal outside a CHECK list or enum: rejected;
 * (d) an ON CONFLICT target no unique constraint or index matches: rejected.
 *
 * Only when both are fully known: the write's shape, and a table created by
 * exactly one migrations set that nothing unmodelled touched. A key that is
 * not one of the table's columns means the schema here is not the one the
 * code runs against, so that write is not judged at all.
 */
import type { IndexDef, Schema } from '../unindexed-reads/schema.js';
import type { Column, Literal } from './columns.js';
import type { Contracts, TableContract } from './table.js';
import type { Value } from './rows.js';
import type { Write } from './writes.js';

export interface Database { contracts: Contracts; indexes: Schema }

export interface Issue { message: string; hint: string }

export function writeIssues(write: Write, databases: Database[]): Issue[] {
    const found = databases.filter(db => db.contracts.tables.has(write.table));
    if (found.length !== 1) return [];
    const [db] = found;
    const table = db.contracts.tables.get(write.table)!;
    const indexes = db.indexes.get(write.table);
    if (table.unknown || !indexes || indexes.uncertain) return [];
    const keys = new Set((write.rows ?? []).flatMap(row => [...row.keys()]));
    if ([...keys, ...(write.onConflict ?? [])].some(key => !table.columns.has(key))) return [];
    const issues = [...conflictIssues(write, table, indexes.indexes), ...(write.rows ? rowIssues(write, write.rows, table, db.contracts) : [])];
    return issues.filter((issue, i) => issues.findIndex(other => other.message === issue.message) === i);
}

function rowIssues(write: Write, rows: Map<string, Value>[], table: TableContract, contracts: Contracts): Issue[] {
    return [...table.columns].flatMap(([name, column]) => (column.generated || contracts.domains.has(column.type) ? [] : [
        ...presenceIssues(write, rows, name, column),
        ...outsideValues(write, rows, name, allowedValues(column, table, name, contracts)),
    ]));
}

/** (a) and (b): a required column no row sets, or a bulk write's key some rows leave out. */
function presenceIssues(write: Write, rows: Map<string, Value>[], name: string, column: Column): Issue[] {
    const setBy = rows.filter(row => row.has(name)).length;
    if (setBy === 0) return column.notNull && !column.hasDefault ? [missing(write, name)] : [];
    return setBy < rows.length && write.bulk && unevenFails(column, write.defaultToNull) ? [uneven(write, name, column)] : [];
}

/** Literals the rows give a column that its enum or CHECK list does not allow (compared only with literals of the same kind). */
function outsideValues(write: Write, rows: Map<string, Value>[], name: string, allowed: Allowed | undefined): Issue[] {
    if (!allowed) return [];
    const issues: Issue[] = [];
    for (const row of rows) {
        const value = row.get(name);
        if (!value || value.kind === 'other' || !allowed.values.every(a => a.kind === value.kind)) continue;
        if (!allowed.values.some(a => same(a, value))) issues.push(outside(write, name, value, allowed));
    }
    return issues;
}

/** A key some rows lack gets NULL (defaultToNull, the default) or the column's default (`defaultToNull: false`). */
function unevenFails(column: Column, defaultToNull: boolean | undefined): boolean {
    if (!column.notNull) return false;
    return defaultToNull === true || !column.hasDefault;
}

/** The literals a column accepts: its enum's labels, or a CHECK list on it (the first such list). */
interface Allowed { values: Literal[]; source: string }

function allowedValues(column: Column, table: TableContract, name: string, contracts: Contracts): Allowed | undefined {
    const labels = column.type.endsWith('[]') ? undefined : contracts.enums.get(column.type);
    if (labels) return { values: labels.map(text => ({ kind: 'string', text })), source: `its enum type \`${column.type}\`` };
    const check = table.checks.find(c => c.column === name && c.values);
    return check?.values ? { values: check.values, source: `its CHECK constraint${check.name ? ` \`${check.name}\`` : ''}` } : undefined;
}

function shown(value: Literal): string {
    return value.kind === 'string' ? `'${value.text}'` : value.text;
}

function same(allowed: Literal, value: Literal): boolean {
    return allowed.kind === 'number' ? Number(allowed.text) === Number(value.text) : allowed.text === value.text;
}

function conflictIssues(write: Write, table: TableContract, indexes: IndexDef[]): Issue[] {
    if (!write.onConflict || table.exclusion) return [];
    const target = new Set(write.onConflict);
    const covering = indexes.filter(index => index.unique && index.keys && index.keys.length === target.size && index.keys.every(key => target.has(key)));
    // A partial index arbitrates only for a target with a WHERE (raw SQL can write one); a deferrable constraint never does.
    if (covering.some(index => !index.deferrable && (index.predicate.length === 0 || write.conflictPredicate))) return [];
    const list = write.onConflict.map(c => `\`${c}\``).join(', ');
    if (covering.length > 0) return [unusableKey(write, list, covering.some(index => index.deferrable))];
    return [{
        message: `The ${write.verb} on \`${write.table}\` resolves conflicts on (${list}), but no unique constraint or unique index on \`${write.table}\` covers exactly those columns: Postgres rejects it ("there is no unique or exclusion constraint matching the ON CONFLICT specification").`,
        hint: `Add a unique constraint on (${list}) in a new migration, or name the columns of an existing one.`,
    }];
}

/** Only a partial or a deferrable unique key covers the target: Postgres cannot use either as the arbiter. */
function unusableKey(write: Write, list: string, deferrable: boolean): Issue {
    const why = deferrable
        ? 'only a deferrable unique constraint covers those columns, and Postgres refuses a deferrable constraint as an ON CONFLICT arbiter'
        : 'only a partial unique index (one with a WHERE) covers those columns, and a conflict target without that predicate cannot use it';
    return {
        message: `The ${write.verb} on \`${write.table}\` resolves conflicts on (${list}), but ${why}: Postgres rejects it ("there is no unique or exclusion constraint matching the ON CONFLICT specification").`,
        hint: deferrable
            ? `Add a unique constraint on (${list}) that is NOT DEFERRABLE.`
            : `Add a unique constraint on (${list}) without a WHERE, or write the insert in SQL with the index's predicate after the target.`,
    };
}

function missing(write: Write, column: string): Issue {
    return {
        message: `This ${write.verb} into \`${write.table}\` never sets column \`${column}\`, which is NOT NULL with no default: the database will reject it.`,
        hint: `Set \`${column}\` in every row, or give the column a default in a migration.`,
    };
}

function uneven(write: Write, column: string, contract: Column): Issue {
    const nullSent = write.defaultToNull === true;
    return {
        message: nullSent
            ? `Rows in this ${write.verb} into \`${write.table}\` don't all set \`${column}\`; supabase-js sends the key as NULL for the ones that don't, and \`${column}\` is NOT NULL: the database will reject the whole batch.`
            : `Rows in this ${write.verb} into \`${write.table}\` don't all set \`${column}\`, which is NOT NULL with no default: the database will reject the whole batch.`,
        hint: nullSent && contract.hasDefault
            ? `Set \`${column}\` in every row, or pass \`defaultToNull: false\` so a missing key takes the column's default.`
            : `Set \`${column}\` in every row.`,
    };
}

function outside(write: Write, column: string, value: Literal, allowed: Allowed): Issue {
    const list = allowed.values.map(shown).join(', ');
    return {
        message: `The ${write.verb} into \`${write.table}\` sets \`${column}\` to ${shown(value)}, but ${allowed.source} only allows ${list}: the database will reject it.`,
        hint: `Use one of ${list}, or widen the constraint in a migration.`,
    };
}
