/**
 * Replay Postgres migrations, in order, into the tables they create and the
 * indexes each table ends up with (primary keys and unique constraints count:
 * Postgres backs them with an index).
 *
 * A table touched by DDL this cannot model is marked uncertain, and the gate
 * says nothing about it: a rename, `LIKE … INCLUDING`, inheritance or
 * partitioning, an index statement it cannot parse, or index DDL inside a
 * function or DO body.
 *
 * Row-level security policies are filters a read does not show: a SELECT or
 * ALL policy `auth.uid() = owner_id` makes every user read filter on
 * `owner_id`. Policies made of such comparisons (or `true`) are kept per
 * table; any other policy expression makes the table uncertain.
 */
import { NAME, identifier, parenthesized, relationName, splitStatements, splitTopLevel, unwrap } from './sql.js';

/** One term of a partial index's WHERE, or `unknown` when it is not a plain comparison. */
export type PredicateTerm =
    | { kind: 'eq'; column: string; value: string }
    | { kind: 'notnull'; column: string }
    | { kind: 'null'; column: string }
    | { kind: 'unknown' };

export interface IndexDef {
    name?: string;
    /** Leading key column, or null when the key starts with an expression. */
    leading: string | null;
    predicate: PredicateTerm[];
    /** A unique index, primary key or unique constraint: what an ON CONFLICT target can name. */
    unique: boolean;
    /** Every key column, or null when some key is an expression. */
    keys: string[] | null;
    /** The constraint that owns the index (`DROP CONSTRAINT` removes it), named as Postgres names it when the DDL does not. */
    constraint?: string;
}

export interface TableSchema {
    indexes: IndexDef[];
    /** Policy name → columns its USING clause compares to the user, or null when the expression is not one this reads. */
    policies: Map<string, string[] | null>;
    uncertain: boolean;
}

/** Columns every policy-filtered read of the table also compares, and whether some policy could not be read. */
export function policyFilters(table: TableSchema): { columns: string[]; unknown: boolean } {
    const all = [...table.policies.values()];
    return { columns: [...new Set(all.flatMap(columns => columns ?? []))], unknown: all.some(columns => columns === null) };
}

export type Schema = Map<string, TableSchema>;

/** Replay migration files (already in apply order) into a schema. */
export function replayMigrations(sqlFiles: string[]): Schema {
    const schema: Schema = new Map();
    for (const sql of sqlFiles) {
        for (const statement of splitStatements(sql)) applyStatement(schema, statement);
    }
    return schema;
}

function applyStatement(schema: Schema, statement: string): void {
    const head = statement.slice(0, 40).toLowerCase();
    if (head.startsWith('create table') || head.startsWith('create unlogged table')) createTable(schema, statement);
    else if (/^create (unique )?index/.test(head)) createIndex(schema, statement);
    else if (head.startsWith('drop index')) dropIndexes(schema, statement);
    else if (head.startsWith('drop table')) dropTables(schema, statement);
    else if (head.startsWith('alter table')) alterTable(schema, statement);
    else if (head.startsWith('alter index')) renameIndex(schema, statement);
    else if (head.startsWith('create policy')) createPolicy(schema, statement);
    else if (head.startsWith('drop policy')) dropPolicy(schema, statement);
    else if (head.startsWith('alter policy')) markUncertain(schema, policyTable(statement));
    else if (/^(do |create (or replace )?(function|procedure))/.test(head)) markDynamicDdl(schema, statement);
}

function createTable(schema: Schema, statement: string): void {
    const match = new RegExp(String.raw`^create (?:unlogged )?table (?:if not exists )?(${NAME})\s*`, 'i').exec(statement);
    if (!match) return;
    const name = relationName(match[1]);
    if (/if not exists/i.test(statement.slice(0, match[0].length)) && schema.has(name)) return;
    const body = parenthesized(statement, match[0].length);
    const table: TableSchema = { indexes: [], policies: new Map(), uncertain: false };
    schema.set(name, table);
    if (!body || statement[match[0].length] !== '(' || /\b(inherits|partition)\b/i.test(statement.slice(body.end))) {
        table.uncertain = true;
        return;
    }
    for (const element of splitTopLevel(body.inner, /,/)) addTableElement(table, element, name);
}

/** A column definition (`id uuid PRIMARY KEY`) or a table constraint (`UNIQUE (a, b)`). */
function addTableElement(table: TableSchema, element: string, tableName: string): void {
    if (/^like\s/i.test(element)) {
        table.uncertain = true;
        return;
    }
    const constraint = TABLE_KEY.exec(element);
    if (constraint) {
        table.indexes.push(keyIndex(tableName, constraint[2], constraint[3], constraint[1]));
        return;
    }
    if (/^(constraint|check|foreign key|exclude)\b/i.test(element)) return;
    addColumnKey(table, tableName, element, new RegExp(String.raw`^(${NAME})\s`, 'i').exec(element)?.[1]);
}

const TABLE_KEY = /^(?:constraint (\S+) )?(primary key|unique)(?: nulls (?:not )?distinct)? \(([^)]*)\)/i;

/** The index behind a PRIMARY KEY or UNIQUE constraint on `columns`, under the name Postgres gives it when none is written. */
function keyIndex(tableName: string, kind: string, columns: string, name?: string): IndexDef {
    const keys = columns.split(',').map(identifier);
    const bare = tableName.split('.').pop()!;
    const constraint = name ? identifier(name) : /^primary/i.test(kind) ? `${bare}_pkey` : `${bare}_${keys.join('_')}_key`;
    return { leading: keys[0], predicate: [], unique: true, keys, constraint };
}

/** `code text UNIQUE`, `id uuid PRIMARY KEY`: the column's own key index. */
function addColumnKey(table: TableSchema, tableName: string, element: string, column: string | undefined): void {
    const kind = column ? /\b(primary key|unique)\b/i.exec(element)?.[1] : undefined;
    if (!column || !kind) return;
    const named = /\bconstraint (\S+) (?:primary key|unique)\b/i.exec(element)?.[1];
    table.indexes.push(keyIndex(tableName, kind, identifier(column), named));
}

function createIndex(schema: Schema, statement: string): void {
    const match = new RegExp(
        String.raw`^create (?:unique )?index (?:concurrently )?(?:if not exists )?(${NAME} )?on (?:only )?(${NAME})(?: using \w+)?\s*\(`, 'i',
    ).exec(statement);
    const onTable = new RegExp(String.raw`\bon (?:only )?(${NAME})`, 'i').exec(statement);
    if (!match) {
        markUncertain(schema, onTable ? relationName(onTable[1]) : undefined);
        return;
    }
    const table = schema.get(relationName(match[2]));
    const keys = parenthesized(statement, match[0].length - 1);
    if (!table) return;
    if (!keys) {
        table.uncertain = true;
        return;
    }
    const name = match[1] ? identifier(match[1].trim().split('.').pop()!) : undefined;
    if (name && /if not exists/i.test(statement) && findIndex(schema, name)) return;
    table.indexes.push(indexOf(statement, keys, name));
}

/** The index a CREATE INDEX statement makes, from its key list (`keys`) and what follows it. */
function indexOf(statement: string, keys: { inner: string; end: number }, name: string | undefined): IndexDef {
    const where = /^\s*(?:include \([^)]*\)\s*)?(?:with \([^)]*\)\s*)?(?:tablespace \S+\s*)?where (.*)$/i.exec(statement.slice(keys.end));
    const columns = splitTopLevel(keys.inner, /,/).map(keyColumn);
    const plain = columns.filter((column): column is string => column !== null);
    return {
        name, leading: columns[0] ?? null, predicate: where ? parsePredicate(where[1]) : [],
        unique: /^create unique/i.test(statement), keys: plain.length === columns.length ? plain : null,
    };
}

/** One key's column, or null when the key is an expression such as `lower(email)`. */
function keyColumn(key: string): string | null {
    const column = new RegExp(String.raw`^(${NAME})(?:\s+(?:asc|desc|nulls (?:first|last)|collate \S+|\w+_ops))*$`, 'i').exec(key);
    return column ? identifier(column[1]) : null;
}

/** A conjunction of plain comparisons; anything else is `unknown`, which the gate treats as possibly serving. */
export function parsePredicate(text: string): PredicateTerm[] {
    const cleaned = unwrap(text);
    if (/\bor\b/i.test(cleaned)) return [{ kind: 'unknown' }];
    return splitTopLevel(cleaned, /\s+and\s+/i).map(term => {
        const bare = unwrap(term);
        const notNull = new RegExp(String.raw`^(${NAME}) is not null$`, 'i').exec(bare);
        if (notNull) return { kind: 'notnull', column: identifier(notNull[1]) };
        const isNull = new RegExp(String.raw`^(${NAME}) is null$`, 'i').exec(bare);
        if (isNull) return { kind: 'null', column: identifier(isNull[1]) };
        const eq = new RegExp(String.raw`^(${NAME}) = '((?:[^']|'')*)'(?:::\w+)?$`, 'i').exec(bare);
        if (eq) return { kind: 'eq', column: identifier(eq[1]), value: eq[2].replace(/''/g, "'") };
        return { kind: 'unknown' };
    });
}

function dropIndexes(schema: Schema, statement: string): void {
    const names = statement.replace(/^drop index (?:concurrently )?(?:if exists )?/i, '').replace(/\s+(cascade|restrict)$/i, '');
    for (const raw of names.split(',')) {
        const name = identifier(raw.trim().split('.').pop()!);
        for (const table of schema.values()) table.indexes = table.indexes.filter(index => index.name !== name);
    }
}

function dropTables(schema: Schema, statement: string): void {
    const names = statement.replace(/^drop table (?:if exists )?/i, '').replace(/\s+(cascade|restrict)$/i, '');
    for (const raw of names.split(',')) schema.delete(relationName(raw.trim()));
}

function alterTable(schema: Schema, statement: string): void {
    const match = new RegExp(String.raw`^alter table (?:if exists )?(?:only )?(${NAME}) (.*)$`, 'i').exec(statement);
    if (!match) return;
    const name = relationName(match[1]);
    const table = schema.get(name);
    if (!table) return;
    const rename = new RegExp(String.raw`^rename to (${NAME})$`, 'i').exec(match[2]);
    if (rename) {
        schema.delete(name);
        schema.set(relationName(rename[1]), table);
        return;
    }
    for (const action of splitTopLevel(match[2], /,/)) alterAction(table, action, name);
}

function alterAction(table: TableSchema, action: string, tableName: string): void {
    if (/^rename\b/i.test(action)) {
        table.uncertain = true;
        return;
    }
    const constraint = /^add (?:constraint (\S+) )?(primary key|unique)(?: nulls (?:not )?distinct)?\s*(?:\(([^)]*)\)|using index (\S+))/i.exec(action);
    if (constraint) {
        if (constraint[3]) table.indexes.push(keyIndex(tableName, constraint[2], constraint[3], constraint[1]));
        else adoptIndex(table, identifier(constraint[4].split('.').pop()!), constraint[1]);
        return;
    }
    const dropped = /^drop constraint (?:if exists )?(\S+)/i.exec(action);
    if (dropped) {
        table.indexes = table.indexes.filter(index => index.constraint !== identifier(dropped[1]));
        return;
    }
    const column = new RegExp(String.raw`^add (?:column )?(?:if not exists )?(${NAME})\s`, 'i').exec(action);
    if (column) addColumnKey(table, tableName, action.replace(/^add (?:column )?(?:if not exists )?/i, ''), column[1]);
}

/** `ADD CONSTRAINT c UNIQUE USING INDEX i`: the index now belongs to the constraint, and takes its name. */
function adoptIndex(table: TableSchema, indexName: string, constraint: string | undefined): void {
    const index = table.indexes.find(candidate => candidate.name === indexName);
    if (!index) return;
    index.constraint = constraint ? identifier(constraint) : indexName;
    index.name = index.constraint;
}

function renameIndex(schema: Schema, statement: string): void {
    const match = new RegExp(String.raw`^alter index (?:if exists )?(${NAME}) rename to (${NAME})$`, 'i').exec(statement);
    if (!match) return;
    const index = findIndex(schema, identifier(match[1].split('.').pop()!));
    if (index) index.name = identifier(match[2].split('.').pop()!);
}

/** Index or constraint DDL inside a function or DO body runs later, maybe dynamically: the tables it names are unknown. */
function markDynamicDdl(schema: Schema, statement: string): void {
    const ddl = new RegExp(String.raw`(?:create (?:unique )?index[^;]*? on (?:only )?|alter table (?:if exists )?(?:only )?)(${NAME})`, 'gi');
    let named = false;
    for (const match of statement.matchAll(ddl)) {
        named = true;
        markUncertain(schema, relationName(match[1]));
    }
    if (!named && /\bexecute\b/i.test(statement) && /\b(index|constraint|primary key|unique)\b/i.test(statement)) markUncertain(schema, undefined);
}

/** One table, or every table when the target cannot be named. */
function markUncertain(schema: Schema, name: string | undefined): void {
    if (name === undefined) for (const table of schema.values()) table.uncertain = true;
    else {
        const table = schema.get(name);
        if (table) table.uncertain = true;
    }
}

function createPolicy(schema: Schema, statement: string): void {
    const match = new RegExp(String.raw`^create policy (${NAME}) on (${NAME})(.*)$`, 'i').exec(statement);
    const table = match ? schema.get(relationName(match[2])) : undefined;
    if (!match || !table) return;
    const command = /\bfor (all|select|insert|update|delete)\b/i.exec(match[3])?.[1].toLowerCase() ?? 'all';
    if (command !== 'all' && command !== 'select') return;
    const using = /\busing\s*\(/i.exec(match[3]);
    const body = using ? parenthesized(match[3], using.index + using[0].length - 1) : undefined;
    table.policies.set(identifier(match[1]), using && body ? policyColumns(body.inner) : null);
}

/** Columns a policy compares to the current user (`auth.uid() = col`, `col = (select auth.uid())`); `true` gives none; anything else, null. */
export function policyColumns(expression: string): string[] | null {
    const bare = unwrap(expression);
    if (/^true$/i.test(bare)) return [];
    // splitStatements leaves single spaces, so ` ?` is enough and nothing can backtrack.
    const uidPattern = String.raw`\(? ?(?:select )?auth\.uid\(\) ?\)?(?:::\w+)?`;
    const columns: string[] = [];
    for (const term of splitTopLevel(bare, /\s+(?:and|or)\s+/i)) {
        const inner = unwrap(term);
        const left = new RegExp(String.raw`^${uidPattern} ?= ?(${NAME})(?:::\w+)?$`, 'i').exec(inner);
        const right = new RegExp(String.raw`^(${NAME})(?:::\w+)? ?= ?${uidPattern}$`, 'i').exec(inner);
        const column = left?.[1] ?? right?.[1];
        if (!column) return null;
        columns.push(identifier(column.split('.').pop()!));
    }
    return columns;
}

function dropPolicy(schema: Schema, statement: string): void {
    const match = new RegExp(String.raw`^drop policy (?:if exists )?(${NAME}) on (${NAME})`, 'i').exec(statement);
    if (match) schema.get(relationName(match[2]))?.policies.delete(identifier(match[1]));
}

function policyTable(statement: string): string | undefined {
    const match = new RegExp(String.raw`\bon (${NAME})`, 'i').exec(statement);
    return match ? relationName(match[1]) : undefined;
}

function findIndex(schema: Schema, name: string): IndexDef | undefined {
    for (const table of schema.values()) {
        const found = table.indexes.find(index => index.name === name);
        if (found) return found;
    }
    return undefined;
}
