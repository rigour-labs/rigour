/**
 * imports/barrel-cycle: a runtime re-export (`export … from './x'`) whose target
 * imports this file back, directly or through other project modules.
 *
 * A barrel in an import cycle evaluates before the modules it re-exports have
 * run: exports are undefined at first use, and HMR updates loop through the
 * cycle. TanStack Start's `Hydrate` re-export pulled the app's router into a
 * cycle and caused circular HMR updates. Type-only edges are erased, so they
 * are ignored.
 */
import ts from 'typescript';
import type { RuleContext, SemanticFinding, SemanticRule } from '../../types.js';
import { finding } from './shared.js';

const MAX_VISITED = 2000;
const edgesByChecker = new WeakMap<ts.TypeChecker, Map<ts.SourceFile, ts.SourceFile[]>>();

export const importsBarrelCycle: SemanticRule = {
    id: 'imports/barrel-cycle',
    check(ctx: RuleContext): SemanticFinding[] {
        const { sourceFile, checker } = ctx;
        const findings: SemanticFinding[] = [];
        for (const statement of sourceFile.statements) {
            if (!ts.isExportDeclaration(statement) || statement.isTypeOnly || !statement.moduleSpecifier) continue;
            const target = moduleFile(checker, statement.moduleSpecifier);
            if (!target || !reaches(checker, target, sourceFile)) continue;
            findings.push(finding(ctx, 'imports/barrel-cycle', statement, 'medium',
                `This re-export of \`${(statement.moduleSpecifier as ts.StringLiteral).text}\` closes an import cycle back to this file; its exports can be undefined at first use and HMR updates loop.`,
                'Re-export from a module outside the cycle (a dedicated subpath entry), or break the back-import.'));
        }
        return findings;
    },
};

function reaches(checker: ts.TypeChecker, from: ts.SourceFile, to: ts.SourceFile): boolean {
    const seen = new Set<ts.SourceFile>([from]);
    const queue = [from];
    while (queue.length && seen.size < MAX_VISITED) {
        for (const next of edges(checker, queue.shift()!)) {
            if (next === to) return true;
            if (!seen.has(next)) {
                seen.add(next);
                queue.push(next);
            }
        }
    }
    return false;
}

/** Runtime imports and re-exports of a project file, to other project files. */
function edges(checker: ts.TypeChecker, file: ts.SourceFile): ts.SourceFile[] {
    let cache = edgesByChecker.get(checker);
    if (!cache) edgesByChecker.set(checker, cache = new Map());
    const cached = cache.get(file);
    if (cached) return cached;
    const targets: ts.SourceFile[] = [];
    for (const statement of file.statements) {
        const specifier = runtimeSpecifier(statement);
        const target = specifier && moduleFile(checker, specifier);
        if (target) targets.push(target);
    }
    cache.set(file, targets);
    return targets;
}

function runtimeSpecifier(statement: ts.Statement): ts.Expression | undefined {
    if (ts.isImportDeclaration(statement)) {
        const clause = statement.importClause;
        return clause?.isTypeOnly ? undefined : statement.moduleSpecifier;
    }
    if (ts.isExportDeclaration(statement) && !statement.isTypeOnly) return statement.moduleSpecifier;
    return undefined;
}

function moduleFile(checker: ts.TypeChecker, specifier: ts.Expression): ts.SourceFile | undefined {
    const declaration = checker.getSymbolAtLocation(specifier)?.valueDeclaration;
    if (!declaration || !ts.isSourceFile(declaration) || declaration.isDeclarationFile) return undefined;
    return declaration.fileName.includes('/node_modules/') ? undefined : declaration;
}
