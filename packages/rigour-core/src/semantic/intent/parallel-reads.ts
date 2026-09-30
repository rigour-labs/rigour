/**
 * `await Promise.all([...])` sites where one read failing loses them all.
 *
 * This part is deterministic: two or more calls run together with no
 * handling of their own, and nothing in the function catches the rejection.
 * Whether that is a bug depends on intent (is one of the reads optional?),
 * which the code cannot say; see intent-check.ts.
 */
import ts from 'typescript';
import { enclosingFunction, forEachNode, lineOf, relativeFile, unwrap, type FunctionLike } from '../ast.js';
import { handlesOwnFailure, isInsideTry, isPromiseAll } from '../failure-handling.js';
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
