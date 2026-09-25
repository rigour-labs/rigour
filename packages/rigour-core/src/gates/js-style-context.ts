import ts from 'typescript';
import { classifyCasing, type NamingPattern } from './language-adapters/types.js';

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

function isNextRoute(file: string): boolean {
    return /(?:^|\/)app(?:\/[^/]+)*\/route\.[cm]?[jt]sx?$/.test(file.replace(/\\/g, '/'));
}

function exported(node: ts.Node): boolean {
    return ts.canHaveModifiers(node)
        && Boolean(ts.getModifiers(node)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword));
}

function containsJsx(node: ts.Node): boolean {
    let found = false;
    const visit = (child: ts.Node): void => {
        if (ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child) || ts.isJsxFragment(child)) {
            found = true;
            return;
        }
        if (!found) ts.forEachChild(child, visit);
    };
    ts.forEachChild(node, visit);
    return found;
}

function isComponent(name: string, node: ts.Node, file: string): boolean {
    return /\.[jt]sx$/.test(file) && /^[A-Z]/.test(name) && containsJsx(node);
}

function isModuleConstant(declaration: ts.VariableDeclaration): boolean {
    const list = declaration.parent;
    return ts.isVariableDeclarationList(list)
        && (list.flags & ts.NodeFlags.Const) !== 0
        && ts.isVariableStatement(list.parent)
        && ts.isSourceFile(list.parent.parent);
}

function isFunctionValue(initializer: ts.Expression | undefined): initializer is ts.ArrowFunction | ts.FunctionExpression {
    return Boolean(initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)));
}

/** Extract comparable JS/TS names, excluding framework-defined identifiers. */
export function extractComparableJsNames(content: string, file: string): NamingPattern[] {
    const kind = /\.[jt]sx$/.test(file) ? ts.ScriptKind.TSX : /\.[cm]?ts$/.test(file) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
    const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, kind);
    const patterns: NamingPattern[] = [];
    const route = isNextRoute(file);
    const visit = (node: ts.Node): void => {
        if (ts.isFunctionDeclaration(node) && node.name) {
            const name = node.name.text;
            if (!(route && exported(node) && HTTP_METHODS.has(name)) && !isComponent(name, node, file)) {
                patterns.push({ name, kind: 'function', convention: classifyCasing(name) });
            }
        }
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
            const name = node.name.text;
            const fn = isFunctionValue(node.initializer);
            const statement = node.parent.parent;
            const routeExport = route && HTTP_METHODS.has(name) && ts.isVariableStatement(statement) && exported(statement);
            const component = fn && isComponent(name, node.initializer, file);
            const conventionalConstant = !fn && isModuleConstant(node) && classifyCasing(name) === 'SCREAMING_SNAKE';
            if (!routeExport && !component && !conventionalConstant) {
                patterns.push({ name, kind: fn ? 'function' : 'variable', convention: classifyCasing(name) });
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    return patterns;
}
