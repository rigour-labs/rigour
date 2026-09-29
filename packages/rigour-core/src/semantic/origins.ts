/**
 * Where can an expression's value come from?
 *
 * Traces identifiers back through declarations (const/let initializers and
 * reassignments), destructuring (including an element of `Promise.all([...])`),
 * conditionals and `??`/`||`, using checker symbols rather than names. The
 * result is a set of origins: a call, a parameter, an object literal, another
 * literal, or unknown. Unknown origins are kept so rules can stay silent.
 */
import ts from 'typescript';
import { enclosingFunction, forEachOwnNode, isFunctionLike, propertyNameText, symbolOf, unwrap, type FunctionLike } from './ast.js';

export type Origin =
    | { kind: 'call'; node: ts.CallExpression }
    | { kind: 'param'; fn: FunctionLike; index: number; node: ts.ParameterDeclaration }
    | { kind: 'object'; node: ts.ObjectLiteralExpression }
    | { kind: 'literal'; node: ts.Expression }
    | { kind: 'unknown'; node: ts.Node };

const MAX_DEPTH = 8;

export function originsOf(checker: ts.TypeChecker, expr: ts.Expression, depth = 0, seen = new Set<ts.Node>()): Origin[] {
    const node = unwrap(expr);
    if (depth > MAX_DEPTH || seen.has(node)) return [{ kind: 'unknown', node }];
    seen.add(node);

    if (ts.isCallExpression(node)) return [{ kind: 'call', node }];
    if (ts.isObjectLiteralExpression(node)) return [{ kind: 'object', node }];
    if (ts.isConditionalExpression(node)) {
        return [...originsOf(checker, node.whenTrue, depth + 1, seen), ...originsOf(checker, node.whenFalse, depth + 1, seen)];
    }
    if (ts.isBinaryExpression(node) && isFallbackOperator(node.operatorToken.kind)) {
        return [...originsOf(checker, node.left, depth + 1, seen), ...originsOf(checker, node.right, depth + 1, seen)];
    }
    if (isPlainLiteral(node)) return [{ kind: 'literal', node }];
    if (ts.isIdentifier(node)) return identifierOrigins(checker, node, depth, seen);
    return [{ kind: 'unknown', node }];
}

function isFallbackOperator(kind: ts.SyntaxKind): boolean {
    return kind === ts.SyntaxKind.QuestionQuestionToken || kind === ts.SyntaxKind.BarBarToken;
}

function isPlainLiteral(node: ts.Expression): boolean {
    return ts.isStringLiteralLike(node) || ts.isNumericLiteral(node) || ts.isArrayLiteralExpression(node)
        || node.kind === ts.SyntaxKind.NullKeyword || node.kind === ts.SyntaxKind.TrueKeyword
        || node.kind === ts.SyntaxKind.FalseKeyword || ts.isTemplateExpression(node)
        || (ts.isIdentifier(node) && node.text === 'undefined');
}

function identifierOrigins(checker: ts.TypeChecker, id: ts.Identifier, depth: number, seen: Set<ts.Node>): Origin[] {
    const decl = symbolOf(checker, id)?.valueDeclaration;
    if (!decl) return [{ kind: 'unknown', node: id }];

    if (ts.isParameter(decl) && isFunctionLike(decl.parent)) {
        const param: Origin = { kind: 'param', fn: decl.parent, index: decl.parent.parameters.indexOf(decl), node: decl };
        return decl.initializer ? [param, ...originsOf(checker, decl.initializer, depth + 1, seen)] : [param];
    }
    if (ts.isVariableDeclaration(decl)) {
        const fromInit = decl.initializer ? originsOf(checker, decl.initializer, depth + 1, seen) : [];
        return [...fromInit, ...reassignmentOrigins(checker, decl, depth, seen)];
    }
    if (ts.isBindingElement(decl)) return bindingOrigins(checker, decl, depth, seen);
    return [{ kind: 'unknown', node: decl }];
}

/** `let x = a; ... x = b;` inside the same function: both values are origins. */
function reassignmentOrigins(checker: ts.TypeChecker, decl: ts.VariableDeclaration, depth: number, seen: Set<ts.Node>): Origin[] {
    const list = decl.parent;
    if (!ts.isVariableDeclarationList(list) || (list.flags & ts.NodeFlags.Const) || !ts.isIdentifier(decl.name)) return [];
    const target = checker.getSymbolAtLocation(decl.name);
    const scope = enclosingFunction(decl) ?? decl.getSourceFile();
    const found: Origin[] = [];
    forEachOwnNode(scope, (node) => {
        if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
            && ts.isIdentifier(node.left) && checker.getSymbolAtLocation(node.left) === target) {
            found.push(...originsOf(checker, node.right, depth + 1, seen));
        }
    });
    return found;
}

/**
 * `const [a, b] = await Promise.all([f(), g()])` → b comes from g().
 * `const { x } = obj` → x comes from obj.x when obj is an object literal.
 */
function bindingOrigins(checker: ts.TypeChecker, element: ts.BindingElement, depth: number, seen: Set<ts.Node>): Origin[] {
    const pattern = element.parent;
    const holder = pattern.parent;
    if (!ts.isVariableDeclaration(holder) || !holder.initializer) return [{ kind: 'unknown', node: element }];
    const init = unwrap(holder.initializer);

    if (ts.isArrayBindingPattern(pattern)) {
        const index = pattern.elements.indexOf(element);
        const items = promiseAllItems(init) ?? (ts.isArrayLiteralExpression(init) ? init.elements : undefined);
        const item = items?.[index];
        return item && !ts.isSpreadElement(item) ? originsOf(checker, item, depth + 1, seen) : [{ kind: 'unknown', node: element }];
    }

    const key = propertyNameText(element.propertyName) ?? (ts.isIdentifier(element.name) ? element.name.text : undefined);
    if (!key) return [{ kind: 'unknown', node: element }];
    const values: Origin[] = [];
    for (const origin of originsOf(checker, init, depth + 1, seen)) {
        if (origin.kind !== 'object') {
            values.push(origin);
            continue;
        }
        for (const value of propertyValues(checker, origin.node, key).values) {
            values.push(...originsOf(checker, value, depth + 1, seen));
        }
    }
    return values;
}

/** Elements of `Promise.all([...])` / `Promise.allSettled([...])`, else undefined. */
export function promiseAllItems(expr: ts.Expression): ts.NodeArray<ts.Expression> | undefined {
    const node = unwrap(expr);
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return undefined;
    const target = node.expression;
    if (!ts.isIdentifier(target.expression) || target.expression.text !== 'Promise') return undefined;
    if (target.name.text !== 'all' && target.name.text !== 'allSettled') return undefined;
    const [arg] = node.arguments;
    return arg && ts.isArrayLiteralExpression(arg) ? arg.elements : undefined;
}

export interface PropertyValues {
    /** Direct values for the property. */
    values: ts.Expression[];
    /** Spreads whose object could not be resolved; the property may come from them. */
    unresolvedSpreads: ts.Expression[];
    /** Spread expressions that were resolved, in source order. */
    spreads: ts.Expression[];
}

/** Values an object literal gives to `key`, following `...spread` of other object literals. */
export function propertyValues(checker: ts.TypeChecker, obj: ts.ObjectLiteralExpression, key: string, depth = 0): PropertyValues {
    const result: PropertyValues = { values: [], unresolvedSpreads: [], spreads: [] };
    const matches = (name: string | undefined) => name !== undefined && name.toLowerCase() === key.toLowerCase();
    for (const prop of obj.properties) {
        if (ts.isPropertyAssignment(prop) && matches(propertyNameText(prop.name))) result.values.push(prop.initializer);
        else if (ts.isShorthandPropertyAssignment(prop) && matches(prop.name.text)) result.values.push(prop.name);
        else if (ts.isSpreadAssignment(prop)) collectSpread(checker, prop.expression, key, depth, result);
    }
    return result;
}

function collectSpread(checker: ts.TypeChecker, spread: ts.Expression, key: string, depth: number, into: PropertyValues): void {
    into.spreads.push(spread);
    if (depth > MAX_DEPTH) {
        into.unresolvedSpreads.push(spread);
        return;
    }
    for (const origin of originsOf(checker, spread)) {
        if (origin.kind === 'object') {
            const nested = propertyValues(checker, origin.node, key, depth + 1);
            into.values.push(...nested.values);
            into.unresolvedSpreads.push(...nested.unresolvedSpreads);
        } else if (origin.kind !== 'literal') {
            into.unresolvedSpreads.push(spread);
        }
    }
}
