/**
 * in-memory-aggregation: every page of a paged read is collected into an
 * array that is then only counted or capped.
 *
 * Work and memory grow with the table. A size cap that throws does not bound
 * the cost; it turns growth into an outage once the data passes the cap.
 * Counting belongs in the data store (count / group by) or a paged fold.
 */
import ts from 'typescript';
import { calleeName, forEachNode, forEachOwnNode, isFunctionLike, lineOf, relativeFile, snippet, symbolOf, unwrap, type FunctionLike } from '../ast.js';
import type { RuleContext, SemanticFinding, SemanticRule } from '../types.js';

const PAGED_CALL = /(?:fetch|read|get|list|load|query|select)All|all(?:Pages|Rows|Records)|paginat|eachPage|forEachPage/i;
const PAGE_CURSOR = /^(?:cursor|offset|page|pageToken|nextToken|after|skip|next|startAfter)$/i;
const AGGREGATE_METHODS = new Set(['length', 'reduce', 'some', 'every', 'includes', 'find', 'findIndex', 'indexOf']);

export const inMemoryAggregation: SemanticRule = {
    id: 'in-memory-aggregation',
    check(ctx: RuleContext): SemanticFinding[] {
        const findings: SemanticFinding[] = [];
        forEachNode(ctx.sourceFile, (node) => {
            if (isFunctionLike(node) && node.body) findings.push(...checkFunction(ctx, node));
        });
        return findings;
    },
};

function checkFunction(ctx: RuleContext, fn: FunctionLike): SemanticFinding[] {
    const findings: SemanticFinding[] = [];
    forEachOwnNode(fn, (node) => {
        if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || !node.initializer) return;
        const init = unwrap(node.initializer);
        if (!ts.isArrayLiteralExpression(init) || init.elements.length > 0) return;
        const symbol = ctx.checker.getSymbolAtLocation(node.name);
        if (!symbol) return;
        const finding = checkAccumulator(ctx, fn, node.name, symbol);
        if (finding) findings.push(finding);
    });
    return findings;
}

function checkAccumulator(ctx: RuleContext, fn: FunctionLike, name: ts.Identifier, symbol: ts.Symbol): SemanticFinding | null {
    const refs = references(ctx.checker, fn, symbol, name);
    const fills = refs.filter(isPushTarget);
    const pagedFill = fills.find(ref => isPagedFill(ref, fn));
    if (!pagedFill) return null;

    const others = refs.filter(ref => !isPushTarget(ref));
    const capGuard = others.find(isThrowingSizeCap);
    if (!capGuard && !(others.length > 0 && others.every(isAggregateUse))) return null;

    const pushCall = pagedFill.parent.parent as ts.CallExpression;
    const reason = capGuard
        ? `then capped with \`${snippet(capGuard.parent.parent, 50)}\``
        : 'and then only counted';
    return {
        rule: 'in-memory-aggregation',
        severity: 'high',
        provenance: 'traditional',
        file: relativeFile(ctx.cwd, ctx.sourceFile),
        line: lineOf(pushCall),
        message: `\`${name.text}\` collects every page of a paged read in memory (\`${snippet(pushCall, 70)}\`) ${reason}. `
            + `Time and memory grow with the table, and a cap that throws fails every request once the data passes it.`,
        hint: 'Aggregate where the data lives (count / group by in SQL or an RPC), or fold each page into running totals instead of keeping all rows.',
        evidence: [`${relativeFile(ctx.cwd, ctx.sourceFile)}:${lineOf(pushCall)} ${snippet(pushCall, 70)}`],
    };
}

function references(checker: ts.TypeChecker, fn: FunctionLike, symbol: ts.Symbol, declName: ts.Identifier): ts.Identifier[] {
    const refs: ts.Identifier[] = [];
    forEachOwnNode(fn, (node) => {
        if (ts.isIdentifier(node) && node !== declName && symbolOf(checker, node) === symbol) refs.push(node);
    });
    return refs;
}

/** `ref.push(...)` */
function isPushTarget(ref: ts.Identifier): boolean {
    const access = ref.parent;
    return ts.isPropertyAccessExpression(access) && access.expression === ref && access.name.text === 'push'
        && ts.isCallExpression(access.parent) && access.parent.expression === access;
}

function isPagedFill(ref: ts.Identifier, fn: FunctionLike): boolean {
    const call = ref.parent.parent as ts.CallExpression;
    if (call.arguments.some(arg => containsAwaitedCall(arg, name => PAGED_CALL.test(name)))) return true;
    const loop = enclosingLoop(call, fn);
    return !!loop && containsCursorDrivenAwait(loop);
}

function containsAwaitedCall(node: ts.Node, matches: (name: string) => boolean): boolean {
    let found = false;
    const walk = (n: ts.Node): void => {
        if (found) return;
        if (ts.isAwaitExpression(n)) {
            const awaited = unwrap(n.expression);
            if (ts.isCallExpression(awaited)) {
                const name = calleeName(awaited);
                if (name && matches(name)) found = true;
            }
        }
        if (!found) ts.forEachChild(n, walk);
    };
    walk(node);
    return found;
}

function enclosingLoop(node: ts.Node, fn: FunctionLike): ts.IterationStatement | undefined {
    for (let current = node.parent; current && current !== fn; current = current.parent) {
        if (ts.isForStatement(current) || ts.isWhileStatement(current) || ts.isDoStatement(current)) return current;
    }
    return undefined;
}

/** An awaited call inside the loop whose arguments mention a page cursor. */
function containsCursorDrivenAwait(loop: ts.IterationStatement): boolean {
    let found = false;
    const walk = (n: ts.Node): void => {
        if (found) return;
        if (ts.isAwaitExpression(n) && ts.isCallExpression(unwrap(n.expression))) {
            const call = unwrap(n.expression) as ts.CallExpression;
            found = call.arguments.some(arg => mentionsCursor(arg));
        }
        if (!found) ts.forEachChild(n, walk);
    };
    walk(loop.statement);
    return found;
}

function mentionsCursor(node: ts.Node): boolean {
    let found = false;
    const walk = (n: ts.Node): void => {
        if (found) return;
        if (ts.isIdentifier(n) && PAGE_CURSOR.test(n.text)) found = true;
        else ts.forEachChild(n, walk);
    };
    walk(node);
    return found;
}

/** `if (ref.length > cap) throw ...` */
function isThrowingSizeCap(ref: ts.Identifier): boolean {
    const access = ref.parent;
    if (!ts.isPropertyAccessExpression(access) || access.name.text !== 'length') return false;
    const comparison = access.parent;
    if (!ts.isBinaryExpression(comparison)) return false;
    const op = comparison.operatorToken.kind;
    if (op !== ts.SyntaxKind.GreaterThanToken && op !== ts.SyntaxKind.GreaterThanEqualsToken) return false;
    const statement = comparison.parent;
    return ts.isIfStatement(statement) && statement.expression === comparison && throwsDirectly(statement.thenStatement);
}

function throwsDirectly(statement: ts.Statement): boolean {
    if (ts.isThrowStatement(statement)) return true;
    return ts.isBlock(statement) && statement.statements.some(s => ts.isThrowStatement(s));
}

/** `ref.length`, `ref.reduce(...)`, `ref.filter(...).length`, `new Set(ref).size`. */
function isAggregateUse(ref: ts.Identifier): boolean {
    const access = ref.parent;
    if (ts.isNewExpression(access) && ts.isIdentifier(access.expression) && access.expression.text === 'Set') {
        const size = access.parent;
        return ts.isPropertyAccessExpression(size) && size.name.text === 'size';
    }
    if (!ts.isPropertyAccessExpression(access) || access.expression !== ref) return false;
    if (AGGREGATE_METHODS.has(access.name.text)) return true;
    if (access.name.text === 'filter' && ts.isCallExpression(access.parent)) {
        const after = access.parent.parent;
        return ts.isPropertyAccessExpression(after) && after.name.text === 'length';
    }
    return false;
}
