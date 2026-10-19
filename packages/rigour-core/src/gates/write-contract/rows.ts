/**
 * The rows a supabase-js insert or upsert sends, read from the syntax tree:
 * an object literal, an array literal of them, a `.map(…)` whose callback
 * returns object literals, or a `const` holding one of these that nothing
 * else touches. A spread, a computed key or anything else makes the shape
 * unknown (undefined), and the check says nothing about it.
 */
import ts from 'typescript';

export type Value = { kind: 'string' | 'number'; text: string } | { kind: 'other' };
/** One row: each key it sends, and its value when that is a literal. */
export type Row = Map<string, Value>;

export interface Rows {
    rows: Row[];
    /** Sent as a JSON array: supabase-js names every key of every row as a column. */
    bulk: boolean;
    /** Lines the rows are written on (a `const` they came from included). */
    lines: number[];
}

export function rowsOf(expression: ts.Expression, source: ts.SourceFile, write: ts.Node): Rows | undefined {
    const node = unwrapExpression(expression);
    if (ts.isObjectLiteralExpression(node)) return withLines(rowList([node]), false, node, source);
    if (ts.isArrayLiteralExpression(node)) {
        if (!node.elements.every(element => ts.isObjectLiteralExpression(unwrapExpression(element)))) return undefined;
        return withLines(rowList(node.elements.map(element => unwrapExpression(element) as ts.ObjectLiteralExpression)), true, node, source);
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'map') {
        return withLines(mappedRows(node.arguments[0]), true, node, source);
    }
    if (ts.isIdentifier(node)) {
        const initializer = constInitializer(node, source, write);
        const resolved = initializer && rowsOf(initializer, source, write);
        return resolved && { ...resolved, lines: [...resolved.lines, ...spanLines(node, source)] };
    }
    return undefined;
}

function withLines(rows: Row[] | undefined, bulk: boolean, node: ts.Node, source: ts.SourceFile): Rows | undefined {
    return rows && rows.length > 0 ? { rows, bulk, lines: spanLines(node, source) } : undefined;
}

export function spanLines(node: ts.Node, source: ts.SourceFile): number[] {
    const first = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    const last = source.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
    return Array.from({ length: last - first + 1 }, (_, i) => first + i);
}

export function unwrapExpression(node: ts.Expression): ts.Expression {
    let current = node;
    while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isSatisfiesExpression(current) || ts.isNonNullExpression(current) || ts.isTypeAssertionExpression(current)) {
        current = current.expression;
    }
    return current;
}

function rowList(objects: ts.ObjectLiteralExpression[]): Row[] | undefined {
    const rows = objects.map(rowOf);
    return rows.every(row => row !== undefined) ? rows as Row[] : undefined;
}

/** An object literal's keys and literal values; undefined when a key is computed or spread in. A key set to `undefined` is not sent. */
function rowOf(object: ts.ObjectLiteralExpression): Row | undefined {
    const row: Row = new Map();
    for (const property of object.properties) {
        if (ts.isShorthandPropertyAssignment(property)) {
            row.set(property.name.text, { kind: 'other' });
            continue;
        }
        if (!ts.isPropertyAssignment(property) || !(ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name))) return undefined;
        const value = unwrapExpression(property.initializer);
        if (ts.isIdentifier(value) && value.text === 'undefined') row.delete(property.name.text);
        else row.set(property.name.text, valueOf(value));
    }
    return row;
}

function valueOf(node: ts.Expression): Value {
    if (ts.isStringLiteralLike(node)) return { kind: 'string', text: node.text };
    if (ts.isNumericLiteral(node)) return { kind: 'number', text: node.text };
    if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(node.operand)) return { kind: 'number', text: `-${node.operand.text}` };
    return { kind: 'other' };
}

/** `items.map(item => ({ … }))`, or a callback whose every return is an object literal (a conditional of two counts as both). */
function mappedRows(callback: ts.Expression | undefined): Row[] | undefined {
    if (!callback || !(ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) return undefined;
    if (!ts.isBlock(callback.body)) return objectsOf(callback.body);
    const returns: ts.ReturnStatement[] = [];
    const visit = (node: ts.Node): void => {
        if (ts.isReturnStatement(node)) returns.push(node);
        else if (!ts.isFunctionLike(node) && !ts.isClassLike(node)) ts.forEachChild(node, visit);
    };
    ts.forEachChild(callback.body, visit);
    const rows = returns.map(statement => (statement.expression ? objectsOf(statement.expression) : undefined));
    return returns.length > 0 && rows.every(r => r !== undefined) ? (rows as Row[][]).flat() : undefined;
}

function objectsOf(expression: ts.Expression): Row[] | undefined {
    const node = unwrapExpression(expression);
    if (ts.isObjectLiteralExpression(node)) return rowList([node]);
    if (!ts.isConditionalExpression(node)) return undefined;
    const [whenTrue, whenFalse] = [objectsOf(node.whenTrue), objectsOf(node.whenFalse)];
    return whenTrue && whenFalse ? [...whenTrue, ...whenFalse] : undefined;
}

/**
 * The initializer of the one `const` this identifier names, when nothing else in the file can change what it holds:
 * the name is declared once, and every other use of it is the write itself or a `.length`.
 */
function constInitializer(name: ts.Identifier, source: ts.SourceFile, write: ts.Node): ts.Expression | undefined {
    const declarations: ts.Node[] = [];
    let touched = false;
    const visit = (node: ts.Node): void => {
        if (ts.isIdentifier(node) && node.text === name.text) {
            if (isDeclaration(node)) declarations.push(node.parent);
            else if (!isInside(node, write) && !isPropertyName(node) && !isLength(node)) touched = true;
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    const [declaration] = declarations;
    if (touched || declarations.length !== 1 || !ts.isVariableDeclaration(declaration) || !declaration.initializer) return undefined;
    return ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const ? declaration.initializer : undefined;
}

function isDeclaration(node: ts.Identifier): boolean {
    const parent = node.parent;
    return (ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isBindingElement(parent) || ts.isFunctionDeclaration(parent)) && parent.name === node;
}

/** `x.rows` or `{ rows: 1 }`: a property called the same, not a use of the variable. */
function isPropertyName(node: ts.Identifier): boolean {
    const parent = node.parent;
    return (ts.isPropertyAccessExpression(parent) && parent.name === node) || ((ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent)
        || ts.isPropertyDeclaration(parent) || ts.isMethodDeclaration(parent) || ts.isMethodSignature(parent)) && parent.name === node);
}

function isLength(node: ts.Identifier): boolean {
    return ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node && node.parent.name.text === 'length';
}

function isInside(node: ts.Node, container: ts.Node): boolean {
    return node.getStart() >= container.getStart() && node.getEnd() <= container.getEnd();
}
