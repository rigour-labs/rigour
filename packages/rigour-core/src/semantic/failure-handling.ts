/**
 * Does a call handle its own failure? Shared by the intent checks and the
 * training-site export, so both see a call the same way.
 */
import ts from 'typescript';
import { calledFunction, type FunctionLike } from './ast.js';

export function isPromiseAll(call: ts.CallExpression): boolean {
    return isPromiseMethod(call, 'all');
}

export function isPromiseAllSettled(call: ts.CallExpression): boolean {
    return isPromiseMethod(call, 'allSettled');
}

function isPromiseMethod(call: ts.CallExpression, name: string): boolean {
    const callee = call.expression;
    return ts.isPropertyAccessExpression(callee) && callee.name.text === name
        && ts.isIdentifier(callee.expression) && callee.expression.text === 'Promise';
}

/** Inside a `try` (with a catch) of the same function: the rejection is handled there. */
export function isInsideTry(node: ts.Node, fn: FunctionLike): boolean {
    for (let child: ts.Node = node, parent = node.parent; parent && parent !== fn; child = parent, parent = parent.parent) {
        if (ts.isTryStatement(parent) && parent.tryBlock === child && parent.catchClause) return true;
    }
    return false;
}

/** `x().catch(...)`, `x().then(ok, fail)`, or a callee whose body catches and returns. */
export function handlesOwnFailure(checker: ts.TypeChecker, call: ts.CallExpression): boolean {
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
