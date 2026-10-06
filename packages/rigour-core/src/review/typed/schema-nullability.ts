/**
 * Which table columns are NOT NULL, replayed from SQL migrations in file order, so a row type that
 * says `| null` for one can be called out: every guard on it is dead. The migrations may live in
 * another repository (`gates.redundancy.schema_migrations`), read only.
 *
 * Conservative by construction: a column is NOT NULL only when a statement Rigour understands made
 * it so (a column definition, a primary key, `SET NOT NULL`). A table created any other way
 * (`AS SELECT`, `LIKE`, `PARTITION OF`) or altered in a way not followed here is unknown, and an
 * unknown table or column is never reported.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

/** `schema.table` → column → NOT NULL. A table mapped to `null` is one whose columns cannot be known. */
export type SchemaNullability = Map<string, Map<string, boolean> | null>;

const DEFAULT_SCHEMA = 'public';

/** The migrations in `dirs` (relative to the repository, absolute, or `~/`), replayed in file-name order. Missing folders are skipped. */
export function loadSchemaNullability(root: string, dirs: string[]): SchemaNullability {
    const files: string[] = [];
    for (const dir of dirs) {
        const full = dir.startsWith('~/') ? path.join(os.homedir(), dir.slice(2)) : path.resolve(root, dir);
        let names: string[];
        try {
            names = fs.readdirSync(full).filter(name => name.endsWith('.sql'));
        } catch {
            continue;
        }
        files.push(...names.map(name => path.join(full, name)));
    }
    files.sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
    const schema: SchemaNullability = new Map();
    for (const file of files) applyMigration(schema, fs.readFileSync(file, 'utf8'));
    return schema;
}

/** Applies one migration's statements to the schema in place. */
function applyMigration(schema: SchemaNullability, sql: string): void {
    for (const statement of statements(sql)) {
        const create = /^create\s+(?:(?:global|local)\s+)?(?:(?:temp|temporary|unlogged)\s+)?table\s+(?:if\s+not\s+exists\s+)?([\w."]+)\s*([\s\S]*)$/i.exec(statement);
        if (create) {
            createTable(schema, tableKey(create[1]), create[2]);
            continue;
        }
        const alter = /^alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?([\w."]+)\s+([\s\S]*)$/i.exec(statement);
        if (alter) {
            alterTable(schema, tableKey(alter[1]), alter[2]);
            continue;
        }
        const drop = /^drop\s+table\s+(?:if\s+exists\s+)?([\w.",\s]+?)(?:\s+(?:cascade|restrict))?$/i.exec(statement);
        if (drop) for (const name of splitTopLevel(drop[1])) schema.delete(tableKey(name));
    }
}

function createTable(schema: SchemaNullability, key: string, rest: string): void {
    const body = /^\(([\s\S]*)\)/.exec(rest.trim());
    if (!body || /^\(\s*like\s/i.test(rest.trim()) || /partition\s+of/i.test(rest)) {
        schema.set(key, null);
        return;
    }
    const columns = new Map<string, boolean>();
    for (const part of splitTopLevel(matchingParen(rest.trim()))) {
        const primary = /^(?:constraint\s+[\w"]+\s+)?primary\s+key\s*\(([^)]*)\)/i.exec(part);
        if (primary) {
            for (const col of primary[1].split(',')) columns.set(ident(col), true);
            continue;
        }
        if (/^(?:constraint|unique|check|foreign\s+key|exclude|like)\b/i.test(part)) continue;
        const column = columnDefinition(part);
        if (column) columns.set(column.name, column.notNull);
    }
    schema.set(key, columns);
}

function alterTable(schema: SchemaNullability, key: string, actions: string): void {
    const rename = /^rename\s+to\s+([\w."]+)$/i.exec(actions.trim());
    if (rename) {
        const table = schema.get(key);
        schema.delete(key);
        schema.set(`${key.split('.')[0]}.${ident(rename[1].split('.').pop()!)}`, table ?? null);
        return;
    }
    const columns = schema.get(key);
    if (!columns) return; // unknown table: stays unknown
    for (const action of splitTopLevel(actions)) {
        const add = /^add\s+(?:column\s+)?(?:if\s+not\s+exists\s+)?([\s\S]+)$/i.exec(action);
        if (add && !/^(?:constraint|primary|unique|check|foreign)\b/i.test(add[1])) {
            const column = columnDefinition(add[1]);
            if (column) columns.set(column.name, column.notNull);
            continue;
        }
        const primary = /^add\s+(?:constraint\s+[\w"]+\s+)?primary\s+key\s*\(([^)]*)\)/i.exec(action);
        if (primary) {
            for (const col of primary[1].split(',')) columns.set(ident(col), true);
            continue;
        }
        const nullability = /^alter\s+(?:column\s+)?([\w"]+)\s+(set|drop)\s+not\s+null$/i.exec(action);
        if (nullability) {
            columns.set(ident(nullability[1]), nullability[2].toLowerCase() === 'set');
            continue;
        }
        const dropColumn = /^drop\s+(?:column\s+)?(?:if\s+exists\s+)?([\w"]+)/i.exec(action);
        if (dropColumn && !/^drop\s+constraint\b/i.test(action)) {
            columns.delete(ident(dropColumn[1]));
            continue;
        }
        const renameColumn = /^rename\s+(?:column\s+)?([\w"]+)\s+to\s+([\w"]+)$/i.exec(action);
        if (renameColumn && columns.has(ident(renameColumn[1]))) {
            columns.set(ident(renameColumn[2]), columns.get(ident(renameColumn[1]))!);
            columns.delete(ident(renameColumn[1]));
        }
    }
}

function columnDefinition(text: string): { name: string; notNull: boolean } | undefined {
    const match = /^("(?:[^"]|"")+"|[a-z_][\w$]*)\s+([\s\S]+)$/i.exec(text.trim());
    if (!match) return undefined;
    // Strings and parenthesised expressions (a CHECK, a default, a generated column) say nothing about this column's own constraint.
    let rest = match[2].replace(/'(?:[^']|'')*'/g, "''");
    while (/\([^()]*\)/.test(rest)) rest = rest.replace(/\([^()]*\)/g, '');
    return { name: ident(match[1]), notNull: /\bnot\s+null\b|\bprimary\s+key\b/i.test(rest) };
}

/** `schema.table` with Postgres's folding: unquoted names lower-cased, the schema `public` by default. */
export function tableKey(name: string): string {
    const parts = name.trim().match(/"(?:[^"]|"")+"|[^.]+/g) ?? [];
    const table = parts.at(-1) ?? '';
    const schema = (parts.length > 1 && parts[0]) || DEFAULT_SCHEMA;
    return `${ident(schema)}.${ident(table)}`;
}

function ident(name: string): string {
    const trimmed = name.trim();
    return trimmed.startsWith('"') ? trimmed.slice(1, -1).replace(/""/g, '"') : trimmed.toLowerCase();
}

/** The text inside the parenthesis that opens `text`. */
function matchingParen(text: string): string {
    let depth = 0;
    for (let i = 0; i < text.length; i++) {
        if (text[i] === '(') depth++;
        else if (text[i] === ')' && --depth === 0) return text.slice(1, i);
    }
    return text.slice(1);
}

/** Splits on commas outside parentheses and quotes. */
function splitTopLevel(text: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let quote = '';
    let start = 0;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (quote) {
            if (c === quote) quote = '';
        } else if (c === "'" || c === '"') quote = c;
        else if (c === '(') depth++;
        else if (c === ')') depth--;
        else if (c === ',' && depth === 0) {
            parts.push(text.slice(start, i).trim());
            start = i + 1;
        }
    }
    parts.push(text.slice(start).trim());
    return parts.filter(Boolean);
}

/** The statements of a migration, comments removed, function bodies and strings kept whole. */
function statements(sql: string): string[] {
    const out: string[] = [];
    let current = '';
    let i = 0;
    while (i < sql.length) {
        const rest = sql.slice(i);
        const dollar = /^\$[\w]*\$/.exec(rest);
        if (rest.startsWith('--')) {
            const end = sql.indexOf('\n', i);
            i = end === -1 ? sql.length : end;
        } else if (rest.startsWith('/*')) {
            const end = sql.indexOf('*/', i + 2);
            i = end === -1 ? sql.length : end + 2;
        } else if (dollar) {
            const end = sql.indexOf(dollar[0], i + dollar[0].length);
            const stop = end === -1 ? sql.length : end + dollar[0].length;
            current += sql.slice(i, stop);
            i = stop;
        } else if (sql[i] === "'" || sql[i] === '"') {
            let j = i + 1;
            while (j < sql.length && !(sql[j] === sql[i] && sql[j + 1] !== sql[i])) j += sql[j] === sql[i] ? 2 : 1;
            current += sql.slice(i, j + 1);
            i = j + 1;
        } else if (sql[i] === ';') {
            out.push(current.trim().replace(/\s+/g, ' '));
            current = '';
            i++;
        } else {
            current += sql[i];
            i++;
        }
    }
    if (current.trim()) out.push(current.trim().replace(/\s+/g, ' '));
    return out.filter(Boolean);
}
