/**
 * What guards a value, and whether an options object sets a property.
 *
 * A guard is a condition the value's selection depends on inside the call:
 * `c ? v : w`, `c && v`, or a spread chosen by `...(c ? { k: v } : {})`.
 */
import ts from 'typescript';
import { originsOf, propertyValues } from '../origins.js';
import { propertyNameText, unwrap } from '../ast.js';

const SHORT_CIRCUIT = new Set([ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken]);

/** Conditions between `node` and `stop` (exclusive) that decide whether `node` is used, plus its own `?:` test. */
export function guardsOf(node: ts.Node, stop: ts.Node): ts.Expression[] {
    const guards: ts.Expression[] = [];
    const value = ts.isPropertyAssignment(node) ? unwrap(node.initializer) : undefined;
    if (value && ts.isConditionalExpression(value)) guards.push(value.condition);
    for (let child = node, parent = node.parent; parent && parent !== stop; child = parent, parent = parent.parent) {
        const guard = selectingCondition(parent, child);
        if (guard) guards.push(guard);
    }
    return guards;
}

/** The condition in `parent` that decides whether `child` is evaluated, if any. */
function selectingCondition(parent: ts.Node, child: ts.Node): ts.Expression | undefined {
    if (ts.isConditionalExpression(parent) && child !== parent.condition) return parent.condition;
    if (ts.isBinaryExpression(parent) && parent.right === child && SHORT_CIRCUIT.has(parent.operatorToken.kind)) return parent.left;
    return undefined;
}

/** Identifier and property names read by `exprs`; property names (`x.stepsAvailable`) listed first. */
export function namesIn(exprs: ts.Node[]): string[] {
    const properties: string[] = [];
    const identifiers: string[] = [];
    const walk = (node: ts.Node): void => {
        if (ts.isPropertyAccessExpression(node)) properties.push(node.name.text);
        else if (ts.isIdentifier(node) && !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)) identifiers.push(node.text);
        ts.forEachChild(node, walk);
    };
    exprs.forEach(walk);
    return [...new Set([...properties, ...identifiers])];
}

/** Property assignments named `key` (case-insensitive) anywhere inside `root`. */
export function propertiesNamed(root: ts.Node, key: string): ts.PropertyAssignment[] {
    const found: ts.PropertyAssignment[] = [];
    const wanted = key.toLowerCase();
    const walk = (node: ts.Node): void => {
        if (ts.isPropertyAssignment(node) && propertyNameText(node.name)?.toLowerCase() === wanted) found.push(node);
        ts.forEachChild(node, walk);
    };
    walk(root);
    return found;
}

/** Whether `root` reads `name`, outside the subtree `except`. */
export function mentionsName(root: ts.Node, name: string, except?: ts.Node): boolean {
    let found = false;
    const walk = (node: ts.Node): void => {
        if (found || node === except) return;
        if (ts.isIdentifier(node) && node.text === name) found = true;
        else ts.forEachChild(node, walk);
    };
    walk(root);
    return found;
}

/**
 * Whether `arg` provably sets `property`: an object literal with the property
 * (directly or through a resolved spread), or a variable whose every origin is one.
 */
export function setsProperty(checker: ts.TypeChecker, arg: ts.Expression | undefined, property: string): boolean {
    if (!arg) return false;
    const expr = unwrap(arg);
    if (ts.isObjectLiteralExpression(expr)) return propertyValues(checker, expr, property).values.length > 0;
    const origins = originsOf(checker, expr);
    return origins.length > 0 && origins.every(o => o.kind === 'object' && propertyValues(checker, o.node, property).values.length > 0);
}

/** Property names an object literal argument sets directly. */
export function literalPropertyNames(arg: ts.Expression | undefined): string[] {
    const expr = arg && unwrap(arg);
    if (!expr || !ts.isObjectLiteralExpression(expr)) return [];
    return expr.properties
        .map(p => (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) ? propertyNameText(p.name) : undefined)
        .filter((n): n is string => n !== undefined);
}
