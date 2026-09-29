/**
 * Stable identities for calls and functions, shared by learning and scanning.
 *
 * The same identity must come out of the code before a fix, the fixed code
 * and the rest of the repository, so declaration keys are cwd-relative and
 * function keys are name paths (`Class.method`, `outer>inner`), not positions.
 */
import path from 'path';
import ts from 'typescript';
import { isFunctionLike, propertyNameText, symbolOf, unwrap } from '../ast.js';
import type { CalleeMatcher } from './types.js';

export type Invocation = ts.CallExpression | ts.NewExpression;

export function isInvocation(node: ts.Node): node is Invocation {
    return ts.isCallExpression(node) || ts.isNewExpression(node);
}

export function invocationArgs(call: Invocation): readonly ts.Expression[] {
    return call.arguments ?? [];
}

/** Last name of the callee: `fetch` for `deps.fetch(...)`, `Response` for `new Response(...)`. */
export function calleeNameOf(call: Invocation): string | undefined {
    const callee = unwrap(call.expression);
    if (ts.isIdentifier(callee)) return callee.text;
    if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
    return undefined;
}

export function calleeTextOf(call: Invocation): string {
    return call.expression.getText(call.getSourceFile()).replace(/\s+/g, '');
}

/**
 * `<file>#<qualified name>` of the declaration the callee resolves to: a
 * cwd-relative path inside the project, `lib:<file>` for a library.
 */
export function calleeDeclarationOf(checker: ts.TypeChecker, cwd: string, call: Invocation): string | undefined {
    const decl = symbolOf(checker, call.expression)?.declarations?.[0];
    if (!decl) return undefined;
    const file = decl.getSourceFile().fileName;
    const relative = path.relative(cwd, file).replace(/\\/g, '/');
    const where = relative.startsWith('..') || relative.includes('node_modules/') ? `lib:${path.basename(file)}` : relative;
    return `${where}#${qualifiedName(decl)}`;
}

export function calleeKey(checker: ts.TypeChecker, cwd: string, call: Invocation, level: CalleeMatcher['level']): string | undefined {
    if (level === 'name') return calleeNameOf(call);
    if (level === 'text') return calleeTextOf(call);
    return calleeDeclarationOf(checker, cwd, call);
}

/** Name path of a named declaration: `HttpDeps.fetch`, `Client.send`, `load`. */
function qualifiedName(decl: ts.Declaration): string {
    const names: string[] = [];
    for (let node: ts.Node | undefined = decl; node && !ts.isSourceFile(node); node = node.parent) {
        const name = declarationName(node);
        if (name) names.unshift(name);
    }
    return names.join('.') || '<anonymous>';
}

const NAMED_DECLARATIONS = new Set([
    ts.SyntaxKind.VariableDeclaration, ts.SyntaxKind.FunctionDeclaration, ts.SyntaxKind.ClassDeclaration,
    ts.SyntaxKind.InterfaceDeclaration, ts.SyntaxKind.TypeAliasDeclaration, ts.SyntaxKind.MethodDeclaration,
    ts.SyntaxKind.MethodSignature, ts.SyntaxKind.PropertySignature, ts.SyntaxKind.PropertyDeclaration,
    ts.SyntaxKind.ModuleDeclaration, ts.SyntaxKind.PropertyAssignment,
]);

function declarationName(node: ts.Node): string | undefined {
    if (!NAMED_DECLARATIONS.has(node.kind)) return undefined;
    const name = (node as { name?: ts.PropertyName | ts.BindingName }).name;
    if (!name || ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) return undefined;
    return propertyNameText(name);
}

/** A function-like node with a name: declared, a method, or assigned to a variable or property. */
export function functionName(fn: ts.Node): string | undefined {
    if (!isFunctionLike(fn)) return undefined;
    if ((ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) && fn.name) return propertyNameText(fn.name);
    const parent = fn.parent;
    if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
    if (ts.isPropertyAssignment(parent)) return propertyNameText(parent.name);
    return undefined;
}

/** `outer>inner` path of the named functions around `node`, or `<module>` at the top level. */
export function functionKeyOf(node: ts.Node): string {
    const names: string[] = [];
    for (let current: ts.Node | undefined = node; current && !ts.isSourceFile(current); current = current.parent) {
        const name = functionName(current);
        if (!name) continue;
        const owner = ts.isMethodDeclaration(current) && ts.isClassLike(current.parent) ? current.parent.name?.text : undefined;
        names.unshift(owner ? `${owner}.${name}` : name);
    }
    return names.join('>') || '<module>';
}
