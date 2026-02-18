/**
 * Pattern Indexer — TypeScript / JavaScript AST Helpers
 *
 * Standalone functions for converting TypeScript AST nodes into PatternEntry
 * records and extracting type metadata. No class state is referenced here.
 */

import ts from 'typescript';
import type { PatternEntry, PatternType } from './types.js';
import { createPatternEntry, extractKeywords } from './indexer-helpers.js';

// ---------------------------------------------------------------------------
// Main node → PatternEntry dispatcher
// ---------------------------------------------------------------------------

/**
 * Attempt to convert an AST node into a PatternEntry.
 * Returns `null` for unrecognised node kinds.
 */
export function nodeToPattern(
    node: ts.Node,
    sourceFile: ts.SourceFile,
    filePath: string,
    _content: string,
    minNameLength: number,
): PatternEntry | null {
    const startPos = sourceFile.getLineAndCharacterOfPosition(node.getStart());
    const endPos = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
    const line = startPos.line + 1;
    const endLine = endPos.line + 1;

    // Function declarations
    if (ts.isFunctionDeclaration(node) && node.name) {
        const name = node.name.text;
        if (name.length < minNameLength) return null;
        return createPatternEntry({
            type: detectFunctionType(name, node),
            name,
            file: filePath,
            line,
            endLine,
            signature: getFunctionSignature(node, sourceFile),
            description: getJSDocDescription(node, sourceFile),
            keywords: extractKeywords(name),
            content: node.getText(sourceFile),
            exported: isExported(node),
        });
    }

    // Variable declarations with arrow functions or function expressions
    if (ts.isVariableStatement(node)) {
        for (const decl of node.declarationList.declarations) {
            if (ts.isIdentifier(decl.name) && decl.initializer) {
                const name = decl.name.text;
                if (name.length < minNameLength) continue;

                if (
                    ts.isArrowFunction(decl.initializer) ||
                    ts.isFunctionExpression(decl.initializer)
                ) {
                    return createPatternEntry({
                        type: detectFunctionType(name, decl.initializer),
                        name,
                        file: filePath,
                        line,
                        endLine,
                        signature: getArrowFunctionSignature(decl.initializer, sourceFile),
                        description: getJSDocDescription(node, sourceFile),
                        keywords: extractKeywords(name),
                        content: node.getText(sourceFile),
                        exported: isExported(node),
                    });
                }

                // Constants — UPPER_CASE `const` declarations with a simple initialiser
                const isConst = node.declarationList.flags & ts.NodeFlags.Const;
                if (
                    isConst &&
                    name === name.toUpperCase() &&
                    (ts.isStringLiteral(decl.initializer) ||
                        ts.isNumericLiteral(decl.initializer) ||
                        ts.isObjectLiteralExpression(decl.initializer))
                ) {
                    return createPatternEntry({
                        type: 'constant',
                        name,
                        file: filePath,
                        line,
                        endLine,
                        signature: '',
                        description: getJSDocDescription(node, sourceFile),
                        keywords: extractKeywords(name),
                        content: node.getText(sourceFile),
                        exported: isExported(node),
                    });
                }
            }
        }
    }

    // Class declarations
    if (ts.isClassDeclaration(node) && node.name) {
        const name = node.name.text;
        if (name.length < minNameLength) return null;
        return createPatternEntry({
            type: detectClassType(name, node),
            name,
            file: filePath,
            line,
            endLine,
            signature: getClassSignature(node, sourceFile),
            description: getJSDocDescription(node, sourceFile),
            keywords: extractKeywords(name),
            content: node.getText(sourceFile),
            exported: isExported(node),
        });
    }

    // Interface declarations
    if (ts.isInterfaceDeclaration(node)) {
        const name = node.name.text;
        if (name.length < minNameLength) return null;
        return createPatternEntry({
            type: 'interface',
            name,
            file: filePath,
            line,
            endLine,
            signature: getInterfaceSignature(node, sourceFile),
            description: getJSDocDescription(node, sourceFile),
            keywords: extractKeywords(name),
            content: node.getText(sourceFile),
            exported: isExported(node),
        });
    }

    // Type alias declarations
    if (ts.isTypeAliasDeclaration(node)) {
        const name = node.name.text;
        if (name.length < minNameLength) return null;
        return createPatternEntry({
            type: 'type',
            name,
            file: filePath,
            line,
            endLine,
            signature: node.getText(sourceFile).split('=')[0].trim(),
            description: getJSDocDescription(node, sourceFile),
            keywords: extractKeywords(name),
            content: node.getText(sourceFile),
            exported: isExported(node),
        });
    }

    // Enum declarations
    if (ts.isEnumDeclaration(node)) {
        const name = node.name.text;
        if (name.length < minNameLength) return null;
        return createPatternEntry({
            type: 'enum',
            name,
            file: filePath,
            line,
            endLine,
            signature: `enum ${name}`,
            description: getJSDocDescription(node, sourceFile),
            keywords: extractKeywords(name),
            content: node.getText(sourceFile),
            exported: isExported(node),
        });
    }

    return null;
}

// ---------------------------------------------------------------------------
// Type detection
// ---------------------------------------------------------------------------

export function detectFunctionType(name: string, node: ts.Node): PatternType {
    // React hooks — useXxx
    if (name.startsWith('use') && name.length > 3 && name[3] === name[3].toUpperCase()) {
        return 'hook';
    }
    // React components — PascalCase returning JSX
    if (name[0] === name[0].toUpperCase() && containsJSX(node)) {
        return 'component';
    }
    if (name.includes('Middleware') || name.includes('middleware')) return 'middleware';
    if (name.includes('Handler') || name.includes('handler')) return 'handler';
    if (name.startsWith('create') || name.startsWith('make') || name.includes('Factory')) return 'factory';
    return 'function';
}

export function detectClassType(name: string, node: ts.ClassDeclaration): PatternType {
    if (name.endsWith('Error') || name.endsWith('Exception')) return 'error';
    if (node.heritageClauses) {
        for (const clause of node.heritageClauses) {
            const text = clause.getText();
            if (text.includes('Component') || text.includes('PureComponent')) return 'component';
        }
    }
    if (name.endsWith('Store') || name.endsWith('State')) return 'store';
    if (name.endsWith('Model') || name.endsWith('Entity')) return 'model';
    return 'class';
}

// ---------------------------------------------------------------------------
// Signature helpers
// ---------------------------------------------------------------------------

export function getFunctionSignature(
    node: ts.FunctionDeclaration,
    sourceFile: ts.SourceFile,
): string {
    const params = node.parameters.map(p => p.getText(sourceFile)).join(', ');
    const returnType = node.type ? `: ${node.type.getText(sourceFile)}` : '';
    return `(${params})${returnType}`;
}

export function getArrowFunctionSignature(
    node: ts.ArrowFunction | ts.FunctionExpression,
    sourceFile: ts.SourceFile,
): string {
    const params = node.parameters.map(p => p.getText(sourceFile)).join(', ');
    const returnType = node.type ? `: ${node.type.getText(sourceFile)}` : '';
    return `(${params})${returnType}`;
}

export function getClassSignature(
    node: ts.ClassDeclaration,
    sourceFile: ts.SourceFile,
): string {
    let sig = `class ${node.name?.text || 'Anonymous'}`;
    if (node.heritageClauses) {
        sig += ' ' + node.heritageClauses.map(c => c.getText(sourceFile)).join(' ');
    }
    return sig;
}

export function getInterfaceSignature(
    node: ts.InterfaceDeclaration,
    sourceFile: ts.SourceFile,
): string {
    let sig = `interface ${node.name.text}`;
    if (node.typeParameters) {
        sig += `<${node.typeParameters.map(p => p.getText(sourceFile)).join(', ')}>`;
    }
    return sig;
}

// ---------------------------------------------------------------------------
// JSDoc / export helpers
// ---------------------------------------------------------------------------

export function getJSDocDescription(node: ts.Node, sourceFile: ts.SourceFile): string {
    const jsDocComment = ts.getJSDocCommentsAndTags(node);
    for (const tag of jsDocComment) {
        if (ts.isJSDoc(tag) && tag.comment) {
            if (typeof tag.comment === 'string') return tag.comment;
            return tag.comment.map(c => c.getText(sourceFile)).join(' ');
        }
    }
    return '';
}

export function isExported(node: ts.Node): boolean {
    if (ts.canHaveModifiers(node)) {
        const modifiers = ts.getModifiers(node);
        if (modifiers) {
            return modifiers.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
        }
    }
    return false;
}

// ---------------------------------------------------------------------------
// JSX detection
// ---------------------------------------------------------------------------

export function containsJSX(node: ts.Node): boolean {
    let hasJSX = false;
    const visit = (n: ts.Node) => {
        if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n)) {
            hasJSX = true;
            return;
        }
        ts.forEachChild(n, visit);
    };
    visit(node);
    return hasJSX;
}
