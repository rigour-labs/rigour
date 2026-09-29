/**
 * Small, checker-aware AST helpers shared by the semantic rules.
 */
import path from 'path';
import ts from 'typescript';

export type FunctionLike =
    | ts.FunctionDeclaration
    | ts.FunctionExpression
    | ts.ArrowFunction
    | ts.MethodDeclaration;

export function isFunctionLike(node: ts.Node): node is FunctionLike {
    return ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)
        || ts.isArrowFunction(node) || ts.isMethodDeclaration(node);
}

/** Drop parentheses, type assertions, non-null and `await` around an expression. */
export function unwrap(expr: ts.Expression): ts.Expression {
    let current = expr;
    for (;;) {
        if (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isNonNullExpression(current)
            || ts.isTypeAssertionExpression(current) || ts.isSatisfiesExpression(current) || ts.isAwaitExpression(current)) {
            current = current.expression;
        } else {
            return current;
        }
    }
}

/**
 * Symbol for a node, following import aliases to the declaration. For the
 * name in a shorthand property (`{ headers }`) this is the variable it reads,
 * not the property it creates.
 */
export function symbolOf(checker: ts.TypeChecker, node: ts.Node): ts.Symbol | undefined {
    const symbol = ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node
        ? checker.getShorthandAssignmentValueSymbol(node.parent)
        : checker.getSymbolAtLocation(node);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) return checker.getAliasedSymbol(symbol);
    return symbol;
}

/** The function a call invokes, when it resolves to one declared in source. */
export function calledFunction(checker: ts.TypeChecker, call: ts.CallExpression): FunctionLike | undefined {
    const symbol = symbolOf(checker, call.expression);
    for (const decl of symbol?.declarations ?? []) {
        if (isFunctionLike(decl) && decl.body) return decl;
        if ((ts.isVariableDeclaration(decl) || ts.isPropertyAssignment(decl)) && decl.initializer) {
            const init = unwrap(decl.initializer);
            if (isFunctionLike(init) && init.body) return init;
        }
    }
    return undefined;
}

/** `fetch` in `fetch(...)`, `deps.fetch(...)`, `this.fetch(...)`. */
export function calleeName(call: ts.CallExpression): string | undefined {
    const callee = unwrap(call.expression);
    if (ts.isIdentifier(callee)) return callee.text;
    if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
    return undefined;
}

export function enclosingFunction(node: ts.Node): FunctionLike | undefined {
    for (let current = node.parent; current; current = current.parent) {
        if (isFunctionLike(current)) return current;
    }
    return undefined;
}

/** Visit every descendant of `root` that belongs to `root` itself, not to a nested function. */
export function forEachOwnNode(root: ts.Node, visit: (node: ts.Node) => void): void {
    const walk = (node: ts.Node): void => {
        visit(node);
        if (node !== root && isFunctionLike(node)) return;
        ts.forEachChild(node, walk);
    };
    ts.forEachChild(root, walk);
}

export function forEachNode(root: ts.Node, visit: (node: ts.Node) => void): void {
    const walk = (node: ts.Node): void => {
        visit(node);
        ts.forEachChild(node, walk);
    };
    ts.forEachChild(root, walk);
}

/** Text of a property name (`a`, `'a'`, `"x-token"`), or undefined for computed names. */
export function propertyNameText(name: ts.PropertyName | undefined): string | undefined {
    if (!name) return undefined;
    if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
    if (ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
    return undefined;
}

export function lineOf(node: ts.Node): number {
    const sf = node.getSourceFile();
    return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

/** "http.ts:51" style location for evidence, relative to cwd. */
export function locationOf(cwd: string, node: ts.Node): string {
    return `${relativeFile(cwd, node.getSourceFile())}:${lineOf(node)}`;
}

export function relativeFile(cwd: string, sf: ts.SourceFile): string {
    return path.relative(cwd, sf.fileName).replace(/\\/g, '/');
}

/** Short, single-line source text for messages. */
export function snippet(node: ts.Node, max = 60): string {
    const text = node.getText(node.getSourceFile()).replace(/\s+/g, ' ');
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** True when any identifier inside `expr` resolves to `target`. */
export function mentionsSymbol(checker: ts.TypeChecker, expr: ts.Node, target: ts.Symbol): boolean {
    let found = false;
    const walk = (node: ts.Node): void => {
        if (found) return;
        if (ts.isIdentifier(node) && symbolOf(checker, node) === target) found = true;
        else ts.forEachChild(node, walk);
    };
    walk(expr);
    return found;
}
