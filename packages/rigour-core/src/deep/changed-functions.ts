/**
 * Functions a change touched: the outermost function around each changed line.
 * Shared by the reference pack (callees and callers of the change) and
 * differential tests (the exported functions to exercise).
 */
import ts from 'typescript';
import { forEachNode, isFunctionLike, type FunctionLike } from '../semantic/ast.js';

/**
 * Lines come from `sourceFile` directly, so this works on an unbound program
 * too (parent pointers exist only once a type checker has been created).
 */
export function changedFunctions(sourceFile: ts.SourceFile, focusLines: number[]): FunctionLike[] {
    const found: FunctionLike[] = [];
    forEachNode(sourceFile, (node) => {
        if (!isFunctionLike(node) || !node.body) return;
        const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
        const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
        if (focusLines.some(l => l >= start && l <= end) && !found.some(outer => outer.pos <= node.pos && node.end <= outer.end)) found.push(node);
    });
    return found;
}

/** `export function f` or `export const f = () => …`. */
export function isExported(fn: FunctionLike): boolean {
    const holder = ts.isFunctionDeclaration(fn) ? fn : fn.parent?.parent?.parent;
    return !!holder && ts.canHaveModifiers(holder) && !!ts.getModifiers(holder)?.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
}

export function functionName(fn: FunctionLike): string | undefined {
    if (ts.isFunctionDeclaration(fn)) return fn.name?.text;
    const decl = fn.parent;
    return decl && ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name) ? decl.name.text : undefined;
}
