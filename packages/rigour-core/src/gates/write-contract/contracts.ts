/**
 * Replay Postgres migrations into each table's write contract: its columns
 * (NOT NULL, DEFAULT, generated, identity, type), its CHECK lists, and the
 * enum types those columns use. The indexes an ON CONFLICT target needs come
 * from the unindexed-reads replay (schema.ts), which reads the same files.
 *
 * Precision first: a table touched by anything this does not model is
 * `unknown`, and nothing is reported for it. That covers a statement that
 * names the table and is not one this reads, an ALTER TABLE action it does not
 * know, a BEFORE INSERT trigger or a rule (either can fill or rewrite a row),
 * and a column or constraint definition it cannot parse.
 */
import { NAME, parenthesized, relationName, splitStatements, splitTopLevel } from '../unindexed-reads/sql.js';
import { alterTable } from './alter.js';
import { addElement, markTable, type Contracts, type TableContract } from './table.js';

/** Statements that never change what a table accepts on insert. */
const HARMLESS = /^(comment on|grant|revoke|create (unique )?index|drop index|alter index|reindex|create policy|drop policy|alter policy|create extension|alter extension|create schema|insert into|update |delete from|select |with |create (or replace )?(materialized )?view|drop (materialized )?view|refresh materialized|set |reset |begin|commit|start transaction|create sequence|alter sequence|drop sequence|notify|analyze|vacuum|create publication|alter publication|alter default privileges|create role|alter role|drop function|drop trigger|alter function|create (or replace )?function|create (or replace )?procedure|do |security label|truncate|cluster|lock |savepoint|release|rollback|drop domain|drop extension|create aggregate|create operator|create cast|create collation|create text search)/i;

export function replayContracts(sqlFiles: string[]): Contracts {
    const contracts: Contracts = { tables: new Map(), enums: new Map(), domains: new Set() };
    for (const sql of sqlFiles) {
        for (const statement of splitStatements(sql)) applyStatement(contracts, statement);
    }
    return contracts;
}

type Handler = (contracts: Contracts, statement: string) => void;

/** Each statement this reads, by how it starts; a rule (it can rewrite an insert) makes its table unknown. */
const HANDLERS: Array<[RegExp, Handler]> = [
    [/^create (unlogged )?table/, createTable],
    [/^alter table/, alterTable],
    [/^drop table/, dropTables],
    [/^create type/, createType],
    [/^alter type/, alterType],
    [/^drop type/, dropTypes],
    [/^create domain/, createDomain],
    [/^create (or replace )?(constraint )?trigger/, createTrigger],
    [/^create (or replace )?rule/, markNamed],
    [/^(create (or replace )?(function|procedure)|do )/, bodyTriggers],
];

function applyStatement(contracts: Contracts, statement: string): void {
    const head = statement.slice(0, 60).toLowerCase();
    const handler = HANDLERS.find(([pattern]) => pattern.test(head))?.[1];
    if (handler) handler(contracts, statement);
    else if (!HARMLESS.test(head)) markNamed(contracts, statement);
}

function createTable(contracts: Contracts, statement: string): void {
    const match = new RegExp(String.raw`^create (?:unlogged )?table (?:if not exists )?(${NAME})\s*`, 'i').exec(statement);
    if (!match) return markNamed(contracts, statement);
    const name = relationName(match[1]);
    if (/if not exists/i.test(match[0]) && contracts.tables.has(name)) return;
    const table: TableContract = { columns: new Map(), checks: [], constraints: new Set(), exclusion: false, unknown: false };
    contracts.tables.set(name, table);
    const body = statement[match[0].length] === '(' ? parenthesized(statement, match[0].length) : undefined;
    if (!body || /\b(inherits|partition)\b/i.test(statement.slice(body.end))) {
        table.unknown = true;
        return;
    }
    for (const element of splitTopLevel(body.inner, /,/)) addElement(table, element, name.split('.').pop()!);
}

function dropTables(contracts: Contracts, statement: string): void {
    const names = statement.replace(/^drop table (?:if exists )?/i, '').replace(/\s+(cascade|restrict)$/i, '');
    for (const raw of names.split(',')) contracts.tables.delete(relationName(raw.trim()));
}

function createType(contracts: Contracts, statement: string): void {
    const match = new RegExp(String.raw`^create type (${NAME}) as enum \(`, 'i').exec(statement);
    if (!match) return;
    const body = parenthesized(statement, match[0].length - 1);
    const labels = body ? splitTopLevel(body.inner, /,/).map(label) : [null];
    contracts.enums.set(relationName(match[1]), labels.every(l => l !== null) ? labels as string[] : null);
}

function alterType(contracts: Contracts, statement: string): void {
    const match = new RegExp(String.raw`^alter type (${NAME}) (.*)$`, 'i').exec(statement);
    if (!match) return;
    const name = relationName(match[1]);
    const labels = contracts.enums.get(name);
    if (!labels) return;
    const added = /^add value (?:if not exists )?('(?:[^']|'')*')(?: (?:before|after) '(?:[^']|'')*')?$/i.exec(match[2]);
    const renamed = /^rename value ('(?:[^']|'')*') to ('(?:[^']|'')*')$/i.exec(match[2]);
    if (added && label(added[1]) !== null) labels.push(label(added[1])!);
    else if (renamed) contracts.enums.set(name, labels.map(l => (l === label(renamed[1]) ? label(renamed[2])! : l)));
    else contracts.enums.set(name, null);
}

function dropTypes(contracts: Contracts, statement: string): void {
    const names = statement.replace(/^drop type (?:if exists )?/i, '').replace(/\s+(cascade|restrict)$/i, '');
    for (const raw of names.split(',')) contracts.enums.delete(relationName(raw.trim()));
}

function createDomain(contracts: Contracts, statement: string): void {
    const match = new RegExp(String.raw`^create domain (${NAME})`, 'i').exec(statement);
    if (match) contracts.domains.add(relationName(match[1]));
}

function label(text: string): string | null {
    const quoted = /^'((?:[^']|'')*)'$/.exec(text.trim());
    return quoted ? quoted[1].replace(/''/g, "'") : null;
}

const TRIGGER = new RegExp(String.raw`create (?:or replace )?(?:constraint )?trigger \S+ (before|after|instead of) (.+?) on (${NAME})`, 'gi');

/** A BEFORE or INSTEAD OF INSERT trigger can fill or replace the row, so what the table requires is unknown. */
function createTrigger(contracts: Contracts, statement: string): void {
    for (const match of statement.matchAll(TRIGGER)) {
        if (match[1].toLowerCase() !== 'after' && /\binsert\b/i.test(match[2])) markTable(contracts, relationName(match[3]));
    }
}

/** A function or DO body that creates a trigger: the same rule as a trigger statement. */
function bodyTriggers(contracts: Contracts, statement: string): void {
    if (/\btrigger\b/i.test(statement)) createTrigger(contracts, statement);
}

/** A statement this does not read: every table it names is unknown. */
function markNamed(contracts: Contracts, statement: string): void {
    const text = statement.toLowerCase();
    for (const name of contracts.tables.keys()) {
        const bare = name.split('.').pop()!.replace(/[.*+?^$()|[\]\\{}]/g, '\\$&');
        const pattern = new RegExp(String.raw`(?:^|[^\w$."])(?:"?\w+"?\.)?"?${bare}"?(?![\w$])`, 'i');
        if (pattern.test(text)) markTable(contracts, name);
    }
}
