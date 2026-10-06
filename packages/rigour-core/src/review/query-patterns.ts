/**
 * Query shapes that cost production, on lines a change adds (query-builder chains such as
 * PostgREST/Supabase, Knex, Drizzle):
 *
 * - offset-paging: `.range(from, to)` or `.offset(n)` inside a loop, or in a callback handed to a
 *   pager (the bounds are the callback's own parameters, so something calls it page after page). Each page re-reads and skips
 *   every row before it, so a sweep over N rows reads O(N²); rows inserted mid-sweep shift pages,
 *   so rows are skipped or read twice. Keyset paging (`.gt(id, last)` + order + limit) does not.
 * - unbounded-window: a lower bound on a time column (`.gt`/`.gte`) taken from a window object
 *   (`window.from`, `range.start`) with no upper bound on the same column in the same query: the
 *   code has a window with an end and reads only half of it, so every run reads up to "now" and
 *   rows written while it runs land in two windows. A bare "since" (everything after an event) is
 *   a legitimate query and is not reported.
 *
 * Read from the syntax tree, so a comment or string never matches.
 */
import { isTestFile } from './test-files.js';
import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import type { Config, Failure } from '../types/index.js';

const CODE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const DECLARATIONS = /\.d\.ts$/;
const TIME_COLUMN = /(_at|_on|At|On|date|Date|time|Time|timestamp|Timestamp)$|^(at|since|until|created|updated)$/;
const LOWER = new Set(['gt', 'gte']);
const UPPER = new Set(['lt', 'lte']);

export function queryPatternFailures(cwd: string, changedLines: Record<string, Set<number>>, config: Config): Failure[] {
    if (!config.gates.query_patterns?.enabled) return [];
    const failures: Failure[] = [];
    for (const [file, lines] of Object.entries(changedLines)) {
        if (!CODE.test(file) || DECLARATIONS.test(file) || isTestFile(file) || lines.size === 0) continue;
        let text: string;
        try {
            text = fs.readFileSync(path.join(cwd, file), 'utf8');
        } catch {
            continue;
        }
        if (!/\.(range|offset|gte?)\(/.test(text)) continue;
        const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
        const lineOf = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        const visit = (node: ts.Node) => {
            if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
                const method = node.expression.name.text;
                const line = lineOf(node.expression.name);
                if (lines.has(line)) {
                    if (isOffsetPage(method, node) && (insideLoop(node) || pagerCallback(node))) failures.push(offsetPaging(file, line, method));
                    if (LOWER.has(method)) {
                        const column = columnOf(node, source);
                        if (column && TIME_COLUMN.test(column.replace(/['"`]/g, '').split('.').pop() ?? '') && fromWindow(node) && !hasUpperBound(node, column, source)) {
                            failures.push(unboundedWindow(file, line, column));
                        }
                    }
                }
            }
            ts.forEachChild(node, visit);
        };
        visit(source);
    }
    return failures;
}

function isOffsetPage(method: string, call: ts.CallExpression): boolean {
    return (method === 'range' && call.arguments.length === 2) || (method === 'offset' && call.arguments.length === 1);
}

/** A loop between the call and the function it is in. */
function insideLoop(node: ts.Node): boolean {
    for (let current = node.parent; current; current = current.parent) {
        if (ts.isForStatement(current) || ts.isForOfStatement(current) || ts.isForInStatement(current) || ts.isWhileStatement(current) || ts.isDoStatement(current)) return true;
        if (ts.isFunctionLike(current)) return false;
    }
    return false;
}

/**
 * The offset comes from a parameter of a function passed as an argument (`readAllPages((from, to) =>
 * q.range(from, to))`): a pager calls it once per page. A named function taking bounds from a
 * request (UI pagination, one page per call) is not this.
 */
function pagerCallback(call: ts.CallExpression): boolean {
    let fn: ts.Node | undefined = call.parent;
    while (fn && !ts.isFunctionLike(fn)) fn = fn.parent;
    if (!fn || !(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) || !ts.isCallExpression(fn.parent) || !fn.parent.arguments.includes(fn as ts.Expression)) return false;
    const params = new Set(fn.parameters.map(p => (ts.isIdentifier(p.name) ? p.name.text : '')).filter(Boolean));
    const offset = call.arguments[0];
    return !!offset && ts.isIdentifier(offset) && params.has(offset.text);
}

/** The lower bound is one end of a window object: `window.from`, `range.start`, `span.begin`. */
function fromWindow(call: ts.CallExpression): boolean {
    const bound = call.arguments[1];
    return !!bound && ts.isPropertyAccessExpression(bound) && /^(from|start|begin|after|lower)$/.test(bound.name.text);
}

function columnOf(call: ts.CallExpression, source: ts.SourceFile): string | undefined {
    const first = call.arguments[0];
    return first ? first.getText(source) : undefined;
}

/** The whole builder chain this call belongs to: every `.method(args)` from its root to its outermost call. */
function chainCalls(call: ts.CallExpression): ts.CallExpression[] {
    let top: ts.Node = call;
    while (top.parent && (ts.isPropertyAccessExpression(top.parent) || (ts.isCallExpression(top.parent) && top.parent.expression === top) || ts.isAwaitExpression(top.parent) || ts.isNonNullExpression(top.parent))) {
        top = top.parent;
    }
    const calls: ts.CallExpression[] = [];
    const walk = (node: ts.Node) => {
        if (ts.isCallExpression(node)) calls.push(node);
        if (ts.isCallExpression(node) || ts.isPropertyAccessExpression(node) || ts.isAwaitExpression(node) || ts.isNonNullExpression(node)) {
            walk(ts.isCallExpression(node) ? node.expression : node.expression);
        }
    };
    walk(top);
    return calls;
}

/**
 * An upper bound on the same column in the same query. A chain built in steps (`let q = …; q = q.lte(…)`)
 * or a bound added through a variable cannot be followed, so a query assembled outside one
 * expression is given the benefit of the doubt: only a single self-contained chain is reported.
 */
function hasUpperBound(call: ts.CallExpression, column: string, source: ts.SourceFile): boolean {
    const calls = chainCalls(call);
    const rooted = calls.some(c => ts.isPropertyAccessExpression(c.expression) && /^(from|select|table|selectFrom)$/.test(c.expression.name.text));
    if (!rooted) return true;
    return calls.some(c => ts.isPropertyAccessExpression(c.expression) && UPPER.has(c.expression.name.text) && c.arguments[0]?.getText(source) === column);
}

function offsetPaging(file: string, line: number, method: string): Failure {
    return {
        id: 'offset-paging',
        title: 'Offset paging in a loop',
        details: `\`.${method}()\` pages by offset inside a loop: every page re-reads the rows before it, and rows written during the sweep shift the pages, so some are skipped or read twice.`,
        severity: 'medium',
        provenance: 'traditional',
        files: [file],
        line,
        hint: 'Page by key instead: order by a unique column and read the next page with `.gt(column, lastSeen)` and a limit.',
    };
}

function unboundedWindow(file: string, line: number, column: string): Failure {
    return {
        id: 'unbounded-window',
        title: 'Time window with no upper bound',
        details: `The query reads ${column} from a lower bound with no upper bound: each run reads up to "now", and rows written while it runs fall into two windows.`,
        severity: 'medium',
        provenance: 'traditional',
        files: [file],
        line,
        hint: `Bound both ends: add \`.lte(${column}, until)\` with the run's own "until".`,
    };
}
