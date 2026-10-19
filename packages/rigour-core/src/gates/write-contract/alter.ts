/**
 * ALTER TABLE, applied to a table's write contract in migration order. Every
 * action is either modelled, known not to change what an insert needs, or
 * makes the table unknown.
 */
import { NAME, identifier, relationName, splitTopLevel } from '../unindexed-reads/sql.js';
import { hasDefault, normalizeType } from './columns.js';
import { addElement, markTable, type Contracts, type TableContract } from './table.js';

/** Actions that leave what an insert needs as it was. */
const HARMLESS = /^(enable|disable|force|no force) row level security$|^(enable|disable) (always |replica )?(trigger|rule)\b|^owner to |^replica identity |^set \(|^reset \(|^cluster on |^set without (cluster|oids)$|^set (logged|unlogged)$|^set tablespace |^set access method |^validate constraint |^alter constraint /i;

export function alterTable(contracts: Contracts, statement: string): void {
    const match = new RegExp(String.raw`^alter table (?:if exists )?(?:only )?(${NAME}) (.*)$`, 'i').exec(statement);
    if (!match) return;
    const name = relationName(match[1]);
    const table = contracts.tables.get(name);
    if (!table) return;
    const rename = new RegExp(String.raw`^rename to (${NAME})$`, 'i').exec(match[2]);
    if (rename) {
        contracts.tables.delete(name);
        contracts.tables.set(relationName(rename[1]), table);
        return;
    }
    const bare = name.split('.').pop()!;
    for (const action of splitTopLevel(match[2], /,/)) {
        if (!applyAction(table, action, bare)) {
            markTable(contracts, name);
            return;
        }
    }
}

/** Apply one action; false when it is not one this models. */
function applyAction(table: TableContract, action: string, bare: string): boolean {
    if (/^(no )?inherit\b/i.test(action)) return false;
    if (HARMLESS.test(action)) return true;
    const add = /^add (?:column )?(if not exists )?(.*)$/i.exec(action);
    if (add) return addAction(table, add[2], bare, !!add[1]);
    const dropConstraint = /^drop constraint (?:if exists )?(\S+)(?: cascade| restrict)?$/i.exec(action);
    if (dropConstraint) return dropNamed(table, identifier(dropConstraint[1]), /if exists/i.test(action));
    const drop = new RegExp(String.raw`^drop (?:column )?(?:if exists )?(${NAME})(?: cascade| restrict)?$`, 'i').exec(action);
    if (drop) return dropColumn(table, identifier(drop[1]));
    const alter = new RegExp(String.raw`^alter (?:column )?(${NAME}) (.*)$`, 'i').exec(action);
    if (alter) return alterColumn(table, identifier(alter[1]), alter[2]);
    return false;
}

function addAction(table: TableContract, element: string, bare: string, ifNotExists: boolean): boolean {
    const column = new RegExp(String.raw`^(${NAME})\s`, 'i').exec(element);
    const isConstraint = /^(constraint|check|primary key|unique|foreign key|exclude)\b/i.test(element);
    if (!isConstraint && ifNotExists && column && table.columns.has(identifier(column[1]))) return true;
    addElement(table, element, bare);
    return !table.unknown;
}

function dropNamed(table: TableContract, name: string, ifExists: boolean): boolean {
    const before = table.checks.length;
    table.checks = table.checks.filter(check => check.name !== name);
    return table.checks.length < before || table.constraints.delete(name) || ifExists;
}

/** A dropped column takes the CHECKs that name only it with it. */
function dropColumn(table: TableContract, name: string): boolean {
    table.columns.delete(name);
    table.checks = table.checks.filter(check => check.column !== name);
    return true;
}

function alterColumn(table: TableContract, name: string, change: string): boolean {
    const column = table.columns.get(name);
    if (!column) return false;
    if (/^set not null$/i.test(change)) column.notNull = true;
    else if (/^drop not null$/i.test(change)) column.notNull = false;
    else if (/^set default /i.test(change)) column.hasDefault = hasDefault(change.slice(4));
    else if (/^drop default$/i.test(change)) column.hasDefault = false;
    else if (/^add generated (always|by default) as identity\b/i.test(change)) Object.assign(column, { notNull: true, hasDefault: true });
    else if (/^drop identity( if exists)?$/i.test(change)) column.hasDefault = false;
    else if (/^drop expression( if exists)?$/i.test(change)) column.generated = false;
    else if (/^(set data )?type /i.test(change)) column.type = normalizeType(change.replace(/^(set data )?type /i, '').replace(/\s+(collate|using)\s.*$/i, ''));
    else return /^(set (statistics|storage|compression) |set \(|reset \(|set generated |restart\b|set (increment|start|minvalue|maxvalue|cycle|no )\b)/i.test(change);
    return true;
}
