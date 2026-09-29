/**
 * `await Promise.all([...])` sites where one read failing loses them all.
 *
 * This part is deterministic: two or more calls run together with no
 * handling of their own, and nothing in the function catches the rejection.
 * Whether that is a bug depends on intent (is one of the reads optional?),
 * which the code cannot say; see intent-check.ts.
 */
import ts from 'typescript';
import { calledFunction, enclosingFunction, forEachNode, lineOf, relativeFile, unwrap, type FunctionLike } from '../ast.js';
import { promiseAllItems } from '../origins.js';
import { functionKeyOf } from '../learn/identity.js';

export interface ParallelRead {
    call: ts.CallExpression;
    /** Callee text, e.g. `fetchStepEngagement`. */
    label: string;
}

export interface ParallelReadSite {
    file: string;
    line: number;
    fnName: string;
    fn: FunctionLike;
    reads: ParallelRead[];
}

export function findParallelReads(cwd: string, checker: ts.TypeChecker, sourceFile: ts.SourceFile): ParallelReadSite[] {
    const sites: ParallelReadSite[] = [];
    forEachNode(sourceFile, (node) => {
        if (!ts.isCallExpression(node) || !isPromiseAll(node)) return;
        const fn = enclosingFunction(node);
        if (!fn || isInsideTry(node, fn)) return;
        const reads = (promiseAllItems(node) ?? [])
            .map(item => unwrap(item))
            .filter((item): item is ts.CallExpression => ts.isCallExpression(item) && !handlesOwnFailure(checker, item))
            .map(call => ({ call, label: call.expression.getText(sourceFile).replace(/\s+/g, '') }));
        if (reads.length < 2) return;
        sites.push({ file: relativeFile(cwd, sourceFile), line: lineOf(node), fnName: functionKeyOf(node), fn, reads });
    });
    return sites;
}

function isPromiseAll(call: ts.CallExpression): boolean {
    const callee = call.expression;
    return ts.isPropertyAccessExpression(callee) && callee.name.text === 'all'
        && ts.isIdentifier(callee.expression) && callee.expression.text === 'Promise';
}

/** Inside a `try` (with a catch) of the same function: the rejection is handled there. */
function isInsideTry(node: ts.Node, fn: FunctionLike): boolean {
    for (let child: ts.Node = node, parent = node.parent; parent && parent !== fn; child = parent, parent = parent.parent) {
        if (ts.isTryStatement(parent) && parent.tryBlock === child && parent.catchClause) return true;
    }
    return false;
}

/** `x().catch(...)`, `x().then(ok, fail)`, or a callee whose body catches and returns. */
function handlesOwnFailure(checker: ts.TypeChecker, call: ts.CallExpression): boolean {
    const callee = call.expression;
    if (ts.isPropertyAccessExpression(callee)) {
        if (callee.name.text === 'catch' || callee.name.text === 'finally') return true;
        if (callee.name.text === 'then' && call.arguments.length >= 2) return true;
    }
    const target = calledFunction(checker, call);
    const body = target?.body;
    return !!body && ts.isBlock(body) && body.statements.some(s => ts.isTryStatement(s) && !!s.catchClause && catchReturns(s.catchClause));
}

function catchReturns(clause: ts.CatchClause): boolean {
    return clause.block.statements.some(s => ts.isReturnStatement(s));
}
