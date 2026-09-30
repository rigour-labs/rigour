/**
 * Shared pieces of the ecosystem rules: framework and library knowledge that
 * no type checker has (Solid's JSX, Vue reactivity, TypeScript's declaration
 * emit, bundler plugin contracts). Each rule is gated on the file's own
 * declared dependencies and imports, so it only speaks where it applies.
 */
import ts from 'typescript';
import type { Provenance, Severity } from '../../../types/index.js';
import { lineOf, relativeFile, snippet } from '../../ast.js';
import type { RuleContext, SemanticFinding } from '../../types.js';

export function finding(
    ctx: RuleContext, rule: string, node: ts.Node, severity: Severity, message: string, hint: string,
    provenance: Provenance = 'traditional',
): SemanticFinding {
    const file = relativeFile(ctx.cwd, ctx.sourceFile);
    return { rule, severity, provenance, file, line: lineOf(node), message, hint, evidence: [`${file}:${lineOf(node)} ${snippet(node, 70)}`] };
}

/** Module specifiers the file imports or re-exports. */
export function importedModules(sourceFile: ts.SourceFile): string[] {
    const modules: string[] = [];
    for (const statement of sourceFile.statements) {
        const specifier = (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) ? statement.moduleSpecifier : undefined;
        if (specifier && ts.isStringLiteral(specifier)) modules.push(specifier.text);
    }
    return modules;
}

export function importsAny(sourceFile: ts.SourceFile, packages: string[]): boolean {
    return importedModules(sourceFile).some(m => packages.some(p => m === p || m.startsWith(`${p}/`)));
}

/** The package a bare specifier names: `@scope/name/sub` -> `@scope/name`, `name/sub` -> `name`. */
export function packageOf(specifier: string): string | undefined {
    if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('node:') || specifier.startsWith('virtual:')) return undefined;
    const parts = specifier.split('/');
    return specifier.startsWith('@') ? (parts.length > 1 ? `${parts[0]}/${parts[1]}` : undefined) : parts[0];
}

export function isJsxFile(sourceFile: ts.SourceFile): boolean {
    return /\.[jt]sx$/i.test(sourceFile.fileName);
}

/** Leading comments of the statement that contains `node`, and of the line above it. */
export function leadingCommentText(sourceFile: ts.SourceFile, node: ts.Node): string {
    let statement: ts.Node = node;
    while (statement.parent && !ts.isSourceFile(statement.parent) && !ts.isBlock(statement.parent)) statement = statement.parent;
    const ranges = ts.getLeadingCommentRanges(sourceFile.text, statement.pos) ?? [];
    return ranges.map(r => sourceFile.text.slice(r.pos, r.end)).join('\n');
}
