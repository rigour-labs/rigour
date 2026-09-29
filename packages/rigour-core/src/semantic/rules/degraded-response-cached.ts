/**
 * degraded-response-cached: an HTTP response that can carry a failure
 * fallback is sent with a positive max-age.
 *
 * A read that fails is often caught and replaced with null or a default so
 * the rest of the answer still renders. If that degraded answer is cached,
 * clients keep serving it after the failure recovers. The rule proves both
 * halves: the body derives from a function that returns a fallback from a
 * `catch`, and the cache header is set without any condition on the body.
 */
import ts from 'typescript';
import { calledFunction, enclosingFunction, forEachNode, forEachOwnNode, lineOf, locationOf, propertyNameText, relativeFile, snippet, symbolOf, unwrap, type FunctionLike } from '../ast.js';
import { originsOf, propertyValues, type Origin } from '../origins.js';
import type { Summaries } from '../summaries.js';
import type { RuleContext, SemanticFinding, SemanticRule } from '../types.js';

const POSITIVE_CACHE = /(?:^|[\s,])(?:s-)?max-age\s*=\s*[1-9]/i;
const RESPONSE_CLASSES = new Set(['Response', 'NextResponse']);

interface CacheEntry { value: ts.StringLiteralLike | ts.NoSubstitutionTemplateLiteral; guards: ts.Expression[] }
/** Parameter index → the cache header that caches it unconditionally. */
type CachedParams = Map<number, CacheEntry>;

export const degradedResponseCached: SemanticRule = {
    id: 'degraded-response-cached',
    check(ctx: RuleContext): SemanticFinding[] {
        const findings: SemanticFinding[] = [];
        forEachNode(ctx.sourceFile, (node) => {
            if (!ts.isCallExpression(node) && !ts.isNewExpression(node)) return;
            const finding = responseParts(node) ? checkDirect(ctx, node) : ts.isCallExpression(node) ? checkCall(ctx, node) : null;
            if (finding) findings.push(finding);
        });
        return findings;
    },
};

/** `Response.json(body, init)`, `NextResponse.json(...)`, `new Response(body, init)`. */
function responseParts(node: ts.CallExpression | ts.NewExpression): { body: ts.Expression; init: ts.Expression } | null {
    const args = node.arguments ?? ts.factory.createNodeArray();
    if (args.length < 2) return null;
    const callee = unwrap(node.expression);
    const isJson = ts.isCallExpression(node) && ts.isPropertyAccessExpression(callee) && callee.name.text === 'json'
        && ts.isIdentifier(callee.expression) && RESPONSE_CLASSES.has(callee.expression.text);
    const isNew = ts.isNewExpression(node) && ts.isIdentifier(callee) && RESPONSE_CLASSES.has(callee.text);
    return isJson || isNew ? { body: args[0], init: args[1] } : null;
}

/** A response built in place from a fallback-derived body, cached without a condition on it. */
function checkDirect(ctx: RuleContext, node: ts.CallExpression | ts.NewExpression): SemanticFinding | null {
    const { body, init } = responseParts(node)!;
    const fallback = fallbackIn(ctx, body);
    if (!fallback) return null;
    const bodySymbols = identifierSymbols(ctx.checker, body);
    const entry = cacheEntries(ctx.checker, init).find(e => POSITIVE_CACHE.test(e.value.text)
        && !e.guards.some(g => [...identifierSymbols(ctx.checker, g)].some(s => bodySymbols.has(s))));
    return entry ? finding(ctx, node, entry, fallback) : null;
}

/** A call to a function that caches one of its parameters, passed a fallback-derived value. */
function checkCall(ctx: RuleContext, call: ts.CallExpression): SemanticFinding | null {
    const fn = calledFunction(ctx.checker, call);
    if (!fn) return null;
    for (const [index, entry] of cachedParams(ctx.summaries, fn)) {
        const arg = call.arguments[index];
        const fallback = arg ? fallbackIn(ctx, arg) : null;
        if (fallback) return finding(ctx, call, entry, fallback);
    }
    return null;
}

function cachedParams(summaries: Summaries, fn: FunctionLike): CachedParams {
    return summaries.memo<CachedParams>('degraded-response-cached:cached-params', fn, new Map(), () => {
        const params: CachedParams = new Map();
        const checker = summaries.checker;
        forEachOwnNode(fn, (node) => {
            if (!ts.isCallExpression(node) && !ts.isNewExpression(node)) return;
            const parts = responseParts(node);
            if (!parts) return;
            for (const index of bodyParams(checker, parts.body, fn)) {
                const param = checker.getSymbolAtLocation(fn.parameters[index].name);
                const entry = cacheEntries(checker, parts.init).find(e => POSITIVE_CACHE.test(e.value.text)
                    && !(param && e.guards.some(g => identifierSymbols(checker, g).has(param))));
                if (entry) params.set(index, entry);
            }
        });
        return params;
    });
}

/** Parameters of `fn` that become the response body, directly or spread into it. */
function bodyParams(checker: ts.TypeChecker, body: ts.Expression, fn: FunctionLike): number[] {
    const indices: number[] = [];
    const collect = (origin: Origin): void => {
        if (origin.kind === 'param' && origin.fn === fn) indices.push(origin.index);
    };
    for (const origin of originsOf(checker, body)) {
        collect(origin);
        if (origin.kind !== 'object') continue;
        for (const spread of propertyValues(checker, origin.node, '').spreads) originsOf(checker, spread).forEach(collect);
    }
    return indices;
}

/** Every `cache-control` value in an init's headers, with the conditions guarding it. */
function cacheEntries(checker: ts.TypeChecker, init: ts.Expression): CacheEntry[] {
    const entries: CacheEntry[] = [];
    for (const origin of originsOf(checker, init)) {
        if (origin.kind !== 'object') continue;
        for (const headers of propertyValues(checker, origin.node, 'headers').values) {
            collectHeaderEntries(checker, headers, [], entries, 0);
        }
    }
    return entries;
}

function collectHeaderEntries(checker: ts.TypeChecker, expr: ts.Expression, guards: ts.Expression[], into: CacheEntry[], depth: number): void {
    if (depth > 6) return;
    const node = unwrap(expr);
    if (ts.isConditionalExpression(node)) {
        collectHeaderEntries(checker, node.whenTrue, [...guards, node.condition], into, depth + 1);
        collectHeaderEntries(checker, node.whenFalse, [...guards, node.condition], into, depth + 1);
        return;
    }
    if (ts.isIdentifier(node)) {
        for (const origin of originsOf(checker, node)) {
            if (origin.kind === 'object') collectHeaderEntries(checker, origin.node, guards, into, depth + 1);
        }
        return;
    }
    if (!ts.isObjectLiteralExpression(node)) return;
    for (const prop of node.properties) {
        if (ts.isSpreadAssignment(prop)) collectHeaderEntries(checker, prop.expression, guards, into, depth + 1);
        else if (ts.isPropertyAssignment(prop) && propertyNameText(prop.name)?.toLowerCase() === 'cache-control') {
            collectValues(prop.initializer, guards, into);
        }
    }
}

function collectValues(expr: ts.Expression, guards: ts.Expression[], into: CacheEntry[]): void {
    const node = unwrap(expr);
    if (ts.isStringLiteralLike(node)) into.push({ value: node, guards });
    else if (ts.isConditionalExpression(node)) {
        collectValues(node.whenTrue, [...guards, node.condition], into);
        collectValues(node.whenFalse, [...guards, node.condition], into);
    }
}

interface Fallback { fn: FunctionLike; node: ts.Node }

/** The catch-fallback a value can carry, found through calls, spreads and property values. */
function fallbackIn(ctx: RuleContext, expr: ts.Expression): Fallback | null {
    return fallbackOf(ctx.summaries, expr, 0);
}

function fallbackOf(summaries: Summaries, expr: ts.Expression, depth: number): Fallback | null {
    if (depth > 4) return null;
    for (const origin of originsOf(summaries.checker, expr)) {
        if (origin.kind === 'call') {
            const fn = calledFunction(summaries.checker, origin.node);
            // A call with no source body (JSON.stringify, String) passes its arguments' values through.
            const found = fn ? returnsFallback(summaries, fn) : fallbackInArguments(summaries, origin.node, depth);
            if (found) return found;
        }
        if (origin.kind === 'object') {
            for (const part of objectParts(origin.node)) {
                for (const id of identifiersIn(part)) {
                    const found = fallbackOf(summaries, id, depth + 1);
                    if (found) return found;
                }
            }
        }
    }
    return null;
}

function fallbackInArguments(summaries: Summaries, call: ts.CallExpression, depth: number): Fallback | null {
    for (const arg of call.arguments) {
        const found = fallbackOf(summaries, arg, depth + 1);
        if (found) return found;
    }
    return null;
}

/** Whether `fn` can return a value produced by a failure fallback, and where. */
function returnsFallback(summaries: Summaries, fn: FunctionLike): Fallback | null {
    return summaries.memo<Fallback | null>('degraded-response-cached:fallback', fn, null, () => {
        let found: Fallback | null = null;
        forEachOwnNode(fn, (node) => {
            if (found || !ts.isReturnStatement(node)) return;
            if (isInsideCatch(node, fn) && isFallbackValue(node.expression)) found = { fn, node };
            else if (node.expression) found = fallbackOf(summaries, node.expression, 1);
        });
        if (!found && !ts.isBlock(fn.body!) && fn.body) found = fallbackOf(summaries, fn.body as ts.Expression, 1);
        return found;
    });
}

function isInsideCatch(node: ts.Node, fn: FunctionLike): boolean {
    for (let current = node.parent; current && current !== fn; current = current.parent) {
        if (ts.isCatchClause(current)) return enclosingFunction(current) === fn;
    }
    return false;
}

/** `return;`, `return null`, `return undefined`, `return []`, `return {}`, `return false`. */
function isFallbackValue(expr: ts.Expression | undefined): boolean {
    if (!expr) return true;
    const node = unwrap(expr);
    return node.kind === ts.SyntaxKind.NullKeyword || node.kind === ts.SyntaxKind.FalseKeyword
        || (ts.isIdentifier(node) && node.text === 'undefined')
        || (ts.isArrayLiteralExpression(node) && node.elements.length === 0)
        || (ts.isObjectLiteralExpression(node) && node.properties.length === 0);
}

/** Property values and spreads of an object literal. */
function objectParts(obj: ts.ObjectLiteralExpression): ts.Expression[] {
    const parts: ts.Expression[] = [];
    for (const prop of obj.properties) {
        if (ts.isPropertyAssignment(prop)) parts.push(prop.initializer);
        else if (ts.isShorthandPropertyAssignment(prop)) parts.push(prop.name);
        else if (ts.isSpreadAssignment(prop)) parts.push(prop.expression);
    }
    return parts;
}

function identifiersIn(expr: ts.Expression): ts.Identifier[] {
    const ids: ts.Identifier[] = [];
    const walk = (node: ts.Node): void => {
        if (ts.isIdentifier(node)) ids.push(node);
        else if (!ts.isPropertyAccessExpression(node)) ts.forEachChild(node, walk);
        else walk(node.expression);
    };
    walk(expr);
    return ids;
}

function identifierSymbols(checker: ts.TypeChecker, expr: ts.Node): Set<ts.Symbol> {
    const symbols = new Set<ts.Symbol>();
    const walk = (node: ts.Node): void => {
        if (ts.isIdentifier(node)) {
            const symbol = symbolOf(checker, node);
            if (symbol) symbols.add(symbol);
        }
        ts.forEachChild(node, walk);
    };
    walk(expr);
    return symbols;
}

function finding(ctx: RuleContext, node: ts.Node, entry: CacheEntry, fallback: Fallback): SemanticFinding {
    const fnName = fallback.fn.name && ts.isIdentifier(fallback.fn.name) ? fallback.fn.name.text : 'a function';
    return {
        rule: 'degraded-response-cached',
        severity: 'medium',
        provenance: 'traditional',
        file: relativeFile(ctx.cwd, ctx.sourceFile),
        line: lineOf(node),
        message: `This response is cached (\`cache-control: ${entry.value.text}\`, ${locationOf(ctx.cwd, entry.value)}) `
            + `but its body can carry the fallback \`${fnName}\` returns when a read fails (${locationOf(ctx.cwd, fallback.node)}). `
            + `A degraded answer then stays cached after the failure recovers.`,
        hint: 'Send `no-store` when any part of the answer is a fallback (for example `cache-control: body.complete ? "private, max-age=300" : "no-store"`).',
        evidence: [`${locationOf(ctx.cwd, entry.value)} ${snippet(entry.value)}`, `${locationOf(ctx.cwd, fallback.node)} ${snippet(fallback.node)}`],
    };
}
