/**
 * Awaited call sites: the places where "should this call's failure be tolerated
 * or passed up?" is a real question. Rigour exports them for training (the
 * driftbench fix miner) and will ask the same question at the same sites at
 * runtime, so training and inference read code through the same extraction.
 *
 * A site is an awaited call, or an element of an awaited Promise.all /
 * Promise.allSettled. It is handled when the call already copes with failure.
 */
import ts from 'typescript';
import { enclosingFunction, forEachNode, lineOf, relativeFile, unwrap } from '../ast.js';
import { handlesOwnFailure, isInsideTry, isPromiseAll, isPromiseAllSettled } from '../failure-handling.js';
import { functionKeyOf } from '../learn/identity.js';

export type HandledBy = 'try' | 'call' | 'all-settled';

export interface CallSite {
    file: string;
    line: number;
    /** Name path of the enclosing function, e.g. `Loader.run>fetchAll`. */
    function: string;
    /** Callee text, e.g. `api.fetchUser`. */
    callee: string;
    /** Occurrence of this callee in the function, 0-based: pairs sites across versions of a file. */
    ordinal: number;
    handledBy: HandledBy | null;
    /** The enclosing function's source, the text a model reads, capped at MAX_SOURCE_LINES. */
    source: string;
}

const MAX_SOURCE_LINES = 120;

export function findCallSites(cwd: string, checker: ts.TypeChecker, sourceFile: ts.SourceFile): CallSite[] {
    const sites: CallSite[] = [];
    const seen = new Map<string, number>();
    forEachNode(sourceFile, (node) => {
        if (!ts.isAwaitExpression(node)) return;
        for (const { call, settled, chained } of awaitedCalls(unwrap(node.expression))) {
            const fn = enclosingFunction(call);
            if (!fn) continue;
            const functionKey = functionKeyOf(call);
            const callee = calleeText(call, sourceFile);
            const slot = `${functionKey}\0${callee}`;
            const ordinal = seen.get(slot) ?? 0;
            seen.set(slot, ordinal + 1);
            sites.push({
                file: relativeFile(cwd, sourceFile),
                line: lineOf(call),
                function: functionKey,
                callee,
                ordinal,
                handledBy: settled ? 'all-settled' : isInsideTry(call, fn) ? 'try' : chained || handlesOwnFailure(checker, call) ? 'call' : null,
                source: fn.getText(sourceFile).split('\n').slice(0, MAX_SOURCE_LINES).join('\n'),
            });
        }
    });
    return sites;
}

interface Awaited { call: ts.CallExpression; settled: boolean; chained: boolean }

/**
 * The calls an await waits on: the call itself, or each element of Promise.all/allSettled.
 * `x().catch(...)` is reported as `x()` handled by its chain, so the site keeps its
 * identity when a fix adds the handler.
 */
function awaitedCalls(expr: ts.Expression): Awaited[] {
    if (!ts.isCallExpression(expr)) return [];
    const settled = isPromiseAllSettled(expr);
    if (isPromiseAll(expr) || settled) {
        const [list] = expr.arguments;
        if (!list || !ts.isArrayLiteralExpression(list)) return [];
        return list.elements.map(e => unwrap(e)).filter(ts.isCallExpression).map(call => ({ ...unchain(call), settled }));
    }
    return [{ ...unchain(expr), settled: false }];
}

function unchain(call: ts.CallExpression): { call: ts.CallExpression; chained: boolean } {
    const callee = call.expression;
    const handler = ts.isPropertyAccessExpression(callee)
        && (callee.name.text === 'catch' || callee.name.text === 'finally' || (callee.name.text === 'then' && call.arguments.length >= 2));
    const inner = handler ? unwrap(callee.expression) : undefined;
    return inner && ts.isCallExpression(inner) ? { call: inner, chained: true } : { call, chained: false };
}

function calleeText(call: ts.CallExpression, sourceFile: ts.SourceFile): string {
    return call.expression.getText(sourceFile).replace(/\s+/g, '');
}
