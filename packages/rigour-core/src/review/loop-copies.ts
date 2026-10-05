/**
 * Quadratic copy: an accumulator copied whole on every step of a loop.
 * `groups.set(k, [...(groups.get(k) ?? []), item])`, `acc = [...acc, item]`, or a reduce that
 * returns `[...acc, item]` / `{ ...acc, [k]: v }` copies everything gathered so far each time, so
 * n items cost O(n²). Pushing into the existing array (or assigning the key) is linear.
 * Reported only on lines a change adds, from the syntax tree.
 */
import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import type { Config, Failure } from '../types/index.js';

const CODE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const BUILD_OUTPUT = /(^|\/)(dist|build|out|coverage|\.next|[\w-]+-dist)\//;

export function loopCopyFailures(cwd: string, changedLines: Record<string, Set<number>>, config: Config): Failure[] {
    if (!config.gates.change_sweep?.enabled) return [];
    const failures: Failure[] = [];
    for (const [file, lines] of Object.entries(changedLines)) {
        if (!CODE.test(file) || BUILD_OUTPUT.test(file) || lines.size === 0) continue;
        let source: ts.SourceFile;
        try {
            const text = fs.readFileSync(path.join(cwd, file), 'utf8');
            if (!text.includes('...')) continue;
            source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
        } catch {
            continue;
        }
        const visit = (node: ts.Node) => {
            const copied = copiedAccumulator(node, source);
            if (copied) {
                const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
                if (lines.has(line)) failures.push(quadratic(file, line, copied));
            }
            ts.forEachChild(node, visit);
        };
        visit(source);
    }
    return failures;
}

/** The accumulator a node copies whole, inside a loop or a reduce, or undefined. */
function copiedAccumulator(node: ts.Node, source: ts.SourceFile): string | undefined {
    // m.set(k, [...(m.get(k) ?? []), v]) in a loop
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'set' && node.arguments.length === 2) {
        const map = node.expression.expression.getText(source);
        const value = node.arguments[1];
        if (ts.isArrayLiteralExpression(value) && value.elements.some(e => ts.isSpreadElement(e) && e.expression.getText(source).replace(/\s+/g, '').startsWith(`(${map}.get(`))) {
            return insideLoop(node) ? `${map}'s list` : undefined;
        }
    }
    // acc = [...acc, v] / acc = { ...acc, k: v } in a loop
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left)) {
        const name = node.left.text;
        if (spreadsItself(node.right, name, source) && insideLoop(node)) return name;
    }
    // reduce((acc, v) => [...acc, v]) or { ...acc, [k]: v }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'reduce') {
        const reducer = node.arguments[0];
        if (reducer && (ts.isArrowFunction(reducer) || ts.isFunctionExpression(reducer)) && reducer.parameters[0] && ts.isIdentifier(reducer.parameters[0].name)) {
            const acc = reducer.parameters[0].name.text;
            const results = ts.isBlock(reducer.body)
                ? collectReturns(reducer.body)
                : [ts.isParenthesizedExpression(reducer.body) ? reducer.body.expression : reducer.body];
            if (results.some(r => spreadsItself(r, acc, source))) return acc;
        }
    }
    return undefined;
}

function spreadsItself(expr: ts.Expression, name: string, source: ts.SourceFile): boolean {
    const unwrapped = ts.isParenthesizedExpression(expr) ? expr.expression : expr;
    if (ts.isArrayLiteralExpression(unwrapped)) return unwrapped.elements.some(e => ts.isSpreadElement(e) && e.expression.getText(source) === name);
    if (ts.isObjectLiteralExpression(unwrapped)) return unwrapped.properties.some(p => ts.isSpreadAssignment(p) && p.expression.getText(source) === name);
    return false;
}

function collectReturns(body: ts.Block): ts.Expression[] {
    const found: ts.Expression[] = [];
    const walk = (node: ts.Node) => {
        if (ts.isFunctionLike(node)) return;
        if (ts.isReturnStatement(node) && node.expression) found.push(node.expression);
        ts.forEachChild(node, walk);
    };
    body.statements.forEach(walk);
    return found;
}

/** A loop (or an array callback that runs per item) between the node and its function. */
function insideLoop(node: ts.Node): boolean {
    for (let current = node.parent; current; current = current.parent) {
        if (ts.isForStatement(current) || ts.isForOfStatement(current) || ts.isForInStatement(current) || ts.isWhileStatement(current) || ts.isDoStatement(current)) return true;
        if (ts.isFunctionLike(current)) {
            const call = current.parent;
            return !!call && ts.isCallExpression(call) && ts.isPropertyAccessExpression(call.expression) && /^(forEach|map|flatMap)$/.test(call.expression.name.text);
        }
    }
    return false;
}

function quadratic(file: string, line: number, accumulator: string): Failure {
    return {
        id: 'quadratic-copy',
        title: 'Accumulator copied on every step',
        details: `${accumulator} is copied whole on every step (spread into a new array or object), so n items cost O(n²) work and allocations.`,
        severity: 'medium',
        provenance: 'traditional',
        files: [file],
        line,
        hint: 'Mutate the accumulator you already own: push onto the existing list (`(m.get(k) ?? m.set(k, []).get(k)!).push(v)`), or assign the key.',
    };
}
