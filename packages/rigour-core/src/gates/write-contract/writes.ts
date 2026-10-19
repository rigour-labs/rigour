/**
 * Writes in a TypeScript or JavaScript file, as the database will receive
 * them: supabase-js `.from('t').insert(rows)` and `.upsert(rows, options)`,
 * and raw SQL `INSERT INTO t (cols) …` written in a string (sql-writes.ts).
 */
import ts from 'typescript';
import { callsAfter, qualified, schemaOf, type ChainCall } from '../unindexed-reads/queries.js';
import { rowsOf, spanLines, unwrapExpression, type Row } from './rows.js';
import { sqlWrites } from './sql-writes.js';

export interface Write {
    table: string;
    line: number;
    /** Every line the write and its rows are written on: a change to any of them puts the finding in the change. */
    lines: number[];
    verb: 'insert' | 'upsert';
    /** The rows' shapes, or undefined when they are not fully known. */
    rows?: Row[];
    /** Sent as a JSON array (supabase-js names every key of every row as a column, and fills a row's missing ones). */
    bulk: boolean;
    /** supabase-js `defaultToNull`: true (the default) sends a missing key as NULL; undefined when it is not a literal. */
    defaultToNull: boolean | undefined;
    /** The ON CONFLICT columns; undefined when there are none or they are not literal. */
    onConflict?: string[];
}

const WRITE_METHODS = new Set(['insert', 'upsert']);

export function findWrites(fileName: string, content: string): Write[] {
    const source = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true);
    const writes: Write[] = [];
    const supabase = /supabase|postgrest/i.test(content);
    const visit = (node: ts.Node): void => {
        const write = supabase ? supabaseWrite(source, node) : undefined;
        if (write) writes.push(write);
        writes.push(...sqlWrites(source, node));
        ts.forEachChild(node, visit);
    };
    visit(source);
    return writes;
}

/** `.from('t').insert(…)` or `.upsert(…)` with a literal table: the table, and the write call. */
function writeCall(node: ts.Node): { table: string; first: ChainCall; from: ts.CallExpression } | undefined {
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression) || node.expression.name.text !== 'from') return undefined;
    const tableArg = node.arguments[0];
    const schema = schemaOf(node.expression.expression);
    const [first] = callsAfter(node);
    if (!tableArg || !ts.isStringLiteralLike(tableArg) || schema === null || !first || !WRITE_METHODS.has(first.method) || !first.args[0]) return undefined;
    return { table: qualified(schema, tableArg.text), first, from: node };
}

/** A write rooted at this `.from('t')` call: its first chained call is `.insert(…)` or `.upsert(…)`. */
function supabaseWrite(source: ts.SourceFile, node: ts.Node): Write | undefined {
    const found = writeCall(node);
    if (!found) return undefined;
    const { first, from } = found;
    const call = from.parent.parent as ts.CallExpression;
    const options = optionsOf(first.args[1]);
    const rows = rowsOf(first.args[0], source, call);
    const line = source.getLineAndCharacterOfPosition((from.parent as ts.PropertyAccessExpression).name.getStart(source)).line + 1;
    return {
        table: found.table,
        line,
        lines: [...new Set([...spanLines(call, source), ...(rows?.lines ?? [])])].sort((a, b) => a - b),
        verb: first.method as Write['verb'],
        rows: rows?.rows,
        bulk: rows?.bulk ?? false,
        ...options,
        ...(first.method === 'insert' ? { onConflict: undefined } : {}),
    };
}

/** `{ onConflict: 'a,b', defaultToNull: false }`; anything not literal is unknown. */
function optionsOf(arg: ts.Expression | undefined): Pick<Write, 'defaultToNull' | 'onConflict'> {
    if (!arg) return { defaultToNull: true };
    const node = unwrapExpression(arg);
    if (!ts.isObjectLiteralExpression(node) || node.properties.some(p => !ts.isPropertyAssignment(p) && !ts.isShorthandPropertyAssignment(p))) return { defaultToNull: undefined };
    const options: Pick<Write, 'defaultToNull' | 'onConflict'> = { defaultToNull: true };
    for (const property of node.properties) applyOption(options, property);
    return options;
}

/** One option: a literal `defaultToNull` or `onConflict`; a shorthand or computed one is unknown. */
function applyOption(options: Pick<Write, 'defaultToNull' | 'onConflict'>, property: ts.ObjectLiteralElementLike): void {
    const key = property.name && (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)) ? property.name.text : undefined;
    const value = ts.isPropertyAssignment(property) ? unwrapExpression(property.initializer) : undefined;
    if (key === 'defaultToNull') options.defaultToNull = booleanLiteral(value);
    if (key === 'onConflict' && value && ts.isStringLiteralLike(value)) options.onConflict = conflictColumns(value.text);
}

function booleanLiteral(node: ts.Expression | undefined): boolean | undefined {
    if (node?.kind === ts.SyntaxKind.TrueKeyword) return true;
    return node?.kind === ts.SyntaxKind.FalseKeyword ? false : undefined;
}

/** `'org_id, "Slug"'`: the columns, as Postgres folds them. */
function conflictColumns(text: string): string[] | undefined {
    const columns = text.split(',').map(c => c.trim()).filter(Boolean);
    if (columns.length === 0 || columns.some(c => !/^(?:"[^"]+"|[A-Za-z_][\w$]*)$/.test(c))) return undefined;
    return columns.map(c => (c.startsWith('"') ? c.slice(1, -1) : c));
}
