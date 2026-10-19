/**
 * Raw SQL inserts written in a string: `INSERT INTO t (a, b) VALUES (…), (…)`,
 * `INSERT INTO t (a, b) SELECT …`, with an optional `ON CONFLICT (cols)`.
 * Only a statement with a column list is read (without one, columns are
 * positional). A template substitution in the table or column list makes
 * the statement unknown; one in a value is just a value this cannot see.
 */
import ts from 'typescript';
import { NAME, identifier, parenthesized, relationName, splitStatements, splitTopLevel } from '../unindexed-reads/sql.js';
import { literal } from './columns.js';
import { spanLines, type Row, type Value } from './rows.js';
import type { Write } from './writes.js';

const PLACEHOLDER = '$__value__';

export function sqlWrites(source: ts.SourceFile, node: ts.Node): Write[] {
    const text = sqlText(node);
    if (text === undefined || !/^\s*insert\s+into\s/i.test(text)) return [];
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    return splitStatements(text).map(statement => parseInsert(statement)).filter(write => write !== undefined)
        .map(write => ({ ...write, line, lines: spanLines(node, source) }));
}

/** A string's text, a template's with each substitution as a placeholder; undefined for any other node. */
function sqlText(node: ts.Node): string | undefined {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (!ts.isTemplateExpression(node)) return undefined;
    return node.head.text + node.templateSpans.map(span => ` ${PLACEHOLDER} ${span.literal.text}`).join('');
}

type ParsedInsert = Omit<Write, 'line' | 'lines'>;

function parseInsert(statement: string): ParsedInsert | undefined {
    const head = new RegExp(String.raw`^insert into (${NAME})(?: as \w+)? ?\(`, 'i').exec(statement);
    const list = head ? parenthesized(statement, head[0].length - 1) : undefined;
    if (!head || !list) return undefined;
    const columns = splitTopLevel(list.inner, /,/).map(column => (new RegExp(String.raw`^${NAME}$`, 'i').test(column) ? identifier(column) : undefined));
    if (columns.length === 0 || columns.some(column => column === undefined)) return undefined;
    const rest = statement.slice(list.end).trim();
    const rows = rowsAfter(rest, columns as string[]);
    if (!rows) return undefined;
    const conflict = conflictTarget(rest);
    return { table: relationName(head[1]), verb: /\bon conflict\b/i.test(blank(rest)) ? 'upsert' : 'insert', rows, bulk: false, defaultToNull: undefined, ...conflict };
}

/** `VALUES (…), (…)` read row by row; `SELECT …` as one row of unknown values. */
function rowsAfter(rest: string, columns: string[]): Row[] | undefined {
    if (/^(select|with)\b/i.test(rest)) return [new Map(columns.map(column => [column, { kind: 'other' }]))];
    const first = /^values ?\(/i.exec(rest);
    if (!first) return undefined;
    const rows: Row[] = [];
    let at = first[0].length - 1;
    while (at >= 0) {
        const group = parenthesized(rest, at);
        if (!group) return undefined;
        const values = splitTopLevel(group.inner, /,/);
        if (values.length !== columns.length) return undefined;
        rows.push(new Map(columns.map((column, i) => [column, valueOf(values[i])])));
        const next = /^\s*,\s*\(/.exec(rest.slice(group.end));
        at = next ? group.end + next[0].length - 1 : -1;
    }
    return rows.length > 0 ? rows : undefined;
}

function valueOf(text: string): Value {
    if (text.includes(PLACEHOLDER)) return { kind: 'other' };
    return literal(text) ?? { kind: 'other' };
}

/** `ON CONFLICT (a, b) [WHERE …]`: its columns, and whether a predicate follows; none for `ON CONSTRAINT`, no target, or an expression. */
function conflictTarget(rest: string): Pick<Write, 'onConflict' | 'conflictPredicate'> {
    const at = /\bon conflict ?\(/i.exec(blank(rest));
    const group = at ? parenthesized(rest, at.index + at[0].length - 1) : undefined;
    if (!group) return {};
    const columns = splitTopLevel(group.inner, /,/);
    if (!columns.every(column => new RegExp(String.raw`^${NAME}$`, 'i').test(column))) return {};
    return { onConflict: columns.map(identifier), conflictPredicate: /^\s*where\b/i.test(rest.slice(group.end)) };
}

/** The text with string literals emptied (same length), so a value never reads as a keyword. */
function blank(text: string): string {
    return text.replace(/'(?:[^']|'')*'/g, match => `'${' '.repeat(match.length - 2)}'`);
}
