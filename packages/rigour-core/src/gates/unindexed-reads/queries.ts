/**
 * supabase-js reads in a TypeScript or JavaScript file: `.from('table')`
 * followed by `.select(…)` and filters, as one call chain.
 *
 * A read is only modelled when every part of it is literal: the table, the
 * filter columns, and the methods. Anything else (a computed table name,
 * `.or(…)`, a filter on an embedded resource, a method this does not know)
 * makes the read `uncertain`, and the gate says nothing about it.
 */
import ts from 'typescript';

export type Filter =
    | { column: string; op: 'eq'; value: string | undefined }
    | { column: string; op: 'in' | 'range' | 'isnull' | 'notnull' | 'match' };

export interface Read {
    table: string;
    line: number;
    filters: Filter[];
    /** First `.order()` column: the only one an index can return rows in. */
    orderBy?: string;
    uncertain: boolean;
}

const RANGE = new Set(['gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'likeAllOf', 'likeAnyOf', 'ilikeAllOf', 'ilikeAnyOf']);
/** Operators a GIN or GiST index could serve: they keep the read silent rather than prove anything. */
const MATCH = new Set(['contains', 'containedBy', 'overlaps', 'textSearch', 'rangeGt', 'rangeGte', 'rangeLt', 'rangeLte', 'rangeAdjacent']);
const NEUTRAL = new Set(['select', 'limit', 'range', 'single', 'maybeSingle', 'returns', 'abortSignal', 'csv', 'geojson', 'explain', 'throwOnError', 'setHeader', 'then', 'neq', 'overrideTypes']);
const WRITES = new Set(['insert', 'update', 'upsert', 'delete']);

export function findReads(fileName: string, content: string): Read[] {
    const source = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true);
    const reads: Read[] = [];
    const visit = (node: ts.Node): void => {
        const read = readAt(source, node);
        if (read) reads.push(read);
        ts.forEachChild(node, visit);
    };
    visit(source);
    return reads;
}

/** A read rooted at this `.from(…)` call, or undefined when the node is not one. */
function readAt(source: ts.SourceFile, node: ts.Node): Read | undefined {
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression) || node.expression.name.text !== 'from') return undefined;
    const tableArg = node.arguments[0];
    const schema = schemaOf(node.expression.expression);
    const chain = callsAfter(node);
    if (!chain.some(call => call.method === 'select') || chain.some(call => WRITES.has(call.method))) return undefined;
    const line = source.getLineAndCharacterOfPosition(node.expression.name.getStart(source)).line + 1;
    const literalTable = tableArg && ts.isStringLiteralLike(tableArg) ? tableArg.text : undefined;
    const read: Read = { table: literalTable ? qualified(schema, literalTable) : '', line, filters: [], uncertain: !literalTable || schema === null };
    for (const call of chain) applyCall(read, call);
    return read;
}

interface ChainCall { method: string; args: readonly ts.Expression[] }

/** Calls chained onto `node`: `.from(…).select(…).eq(…)` gives select, eq. */
function callsAfter(node: ts.CallExpression): ChainCall[] {
    const calls: ChainCall[] = [];
    let current: ts.Node = node;
    while (ts.isPropertyAccessExpression(current.parent) && ts.isCallExpression(current.parent.parent) && current.parent.parent.expression === current.parent) {
        calls.push({ method: current.parent.name.text, args: current.parent.parent.arguments });
        current = current.parent.parent;
    }
    return calls;
}

/** `client.schema('s').from(…)`: the schema name; undefined for the default; null when it is not a literal. */
function schemaOf(target: ts.Expression): string | undefined | null {
    if (!ts.isCallExpression(target) || !ts.isPropertyAccessExpression(target.expression) || target.expression.name.text !== 'schema') return undefined;
    const arg = target.arguments[0];
    return arg && ts.isStringLiteralLike(arg) ? arg.text : null;
}

function qualified(schema: string | undefined | null, table: string): string {
    const name = table.toLowerCase();
    return schema && schema !== 'public' ? `${schema.toLowerCase()}.${name}` : name;
}

function applyCall(read: Read, call: ChainCall): void {
    const { method, args } = call;
    if (NEUTRAL.has(method)) return;
    if (method === 'order') {
        if (read.orderBy === undefined) read.orderBy = columnOf(read, args[0]);
        return;
    }
    if (method === 'match') return applyMatch(read, args[0]);
    if (method === 'not') return applyNot(read, args);
    if (method === 'filter') return applyFilter(read, args);
    const column = columnOf(read, args[0]);
    if (column === undefined) return;
    if (method === 'eq') read.filters.push({ column, op: 'eq', value: literal(args[1]) });
    else if (method === 'in') read.filters.push({ column, op: 'in' });
    else if (method === 'is') read.filters.push(args[1]?.kind === ts.SyntaxKind.NullKeyword ? { column, op: 'isnull' } : { column, op: 'eq', value: literal(args[1]) });
    else if (RANGE.has(method)) read.filters.push({ column, op: 'range' });
    else if (MATCH.has(method)) read.filters.push({ column, op: 'match' });
    else read.uncertain = true;
}

/** `.not('col', 'is', null)` is IS NOT NULL; any other negation filters nothing an index can seek. */
function applyNot(read: Read, args: readonly ts.Expression[]): void {
    const column = columnOf(read, args[0]);
    const op = args[1] && ts.isStringLiteralLike(args[1]) ? args[1].text : undefined;
    if (column !== undefined && op === 'is' && args[2]?.kind === ts.SyntaxKind.NullKeyword) read.filters.push({ column, op: 'notnull' });
    else if (op === undefined) read.uncertain = true;
}

/** `.filter('col', 'eq', v)`: the same as the named method when the operator is a literal. */
function applyFilter(read: Read, args: readonly ts.Expression[]): void {
    const op = args[1] && ts.isStringLiteralLike(args[1]) ? args[1].text : undefined;
    if (op === undefined || !['eq', 'in', 'is', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike'].includes(op)) {
        read.uncertain = true;
        return;
    }
    applyCall(read, { method: op, args: [args[0], args[2]] });
}

/** `.match({ a: 1, b: 'x' })`: equality on each key of an object literal. */
function applyMatch(read: Read, arg: ts.Expression | undefined): void {
    if (!arg || !ts.isObjectLiteralExpression(arg)) {
        read.uncertain = true;
        return;
    }
    for (const property of arg.properties) {
        const name = ts.isPropertyAssignment(property) && (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)) ? property.name.text : undefined;
        if (name === undefined || name.includes('.')) read.uncertain = true;
        else read.filters.push({ column: name.toLowerCase(), op: 'eq', value: literal((property as ts.PropertyAssignment).initializer) });
    }
}

/** A literal column on the read's own table; a computed or embedded (`other.col`) column makes the read uncertain. */
function columnOf(read: Read, arg: ts.Expression | undefined): string | undefined {
    if (!arg || !ts.isStringLiteralLike(arg) || arg.text.includes('.') || arg.text.includes('->')) {
        read.uncertain = true;
        return undefined;
    }
    return arg.text.toLowerCase();
}

/** A literal value as text, or undefined when it is computed at run time. */
function literal(arg: ts.Expression | undefined): string | undefined {
    if (!arg) return undefined;
    if (ts.isStringLiteralLike(arg) || ts.isNumericLiteral(arg)) return arg.text;
    if (arg.kind === ts.SyntaxKind.TrueKeyword) return 'true';
    if (arg.kind === ts.SyntaxKind.FalseKeyword) return 'false';
    return undefined;
}
