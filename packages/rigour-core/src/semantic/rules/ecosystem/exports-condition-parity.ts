/**
 * exports/condition-parity: a conditional entry (`index.react-server.ts`,
 * `index.rsc.ts`, `index.browser.ts`, …) exports fewer names than the package's
 * default `index.ts` beside it.
 *
 * Bundlers pick the conditional entry for that environment, so every name it
 * lacks is an import that works in one environment and fails in another.
 * TanStack Start's `react-server` entry dropped `useServerFn` and broke RSC apps.
 */
import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import type { RuleContext, SemanticFinding, SemanticRule } from '../../types.js';
import { finding } from './shared.js';

const VARIANT = /^index\.([a-z][\w-]*)\.[cm]?[jt]sx?$/i;
const DECLARATION = /\.d\.[cm]?ts$/i;

export const exportsConditionParity: SemanticRule = {
    id: 'exports/condition-parity',
    check(ctx: RuleContext): SemanticFinding[] {
        const { sourceFile } = ctx;
        const base = path.basename(sourceFile.fileName);
        const variant = base.match(VARIANT);
        if (!variant || DECLARATION.test(base)) return [];
        const defaultEntry = siblingIndex(path.dirname(sourceFile.fileName));
        if (!defaultEntry) return [];
        const { checker, entry, variant: own } = entries(ctx, defaultEntry);
        if (!entry || !own) return [];
        const ownNames = exportNames(checker, own);
        const missing = [...exportNames(checker, entry)].filter(name => !ownNames.has(name));
        if (missing.length === 0) return [];
        const anchor = sourceFile.statements.find(s => ts.isExportDeclaration(s)) ?? sourceFile.statements[0] ?? sourceFile;
        const shown = missing.slice(0, 5).map(n => `\`${n}\``).join(', ');
        return [finding(ctx, 'exports/condition-parity', anchor, 'medium',
            `The \`${variant[1]}\` entry lacks ${missing.length} export(s) of ${path.basename(defaultEntry)}: ${shown}${missing.length > 5 ? ', …' : ''}. Imports of them fail only in that environment.`,
            `Re-export them from ${base}, or point the \`${variant[1]}\` condition at the default entry.`)];
    },
};

function siblingIndex(dir: string): string | undefined {
    return ['index.ts', 'index.tsx', 'index.js', 'index.mts'].map(f => path.join(dir, f)).find(f => fs.existsSync(f));
}

/**
 * Both entries in one program: the analysis program when it loaded the default
 * entry (a full check), otherwise a two-file program (a review of the variant alone).
 */
function entries(ctx: RuleContext, defaultEntry: string): { checker: ts.TypeChecker; entry?: ts.SourceFile; variant?: ts.SourceFile } {
    const entry = ctx.program.getSourceFile(defaultEntry);
    if (entry) return { checker: ctx.checker, entry, variant: ctx.sourceFile };
    const options = { ...ctx.project.compilerOptions(ctx.sourceFile.fileName), noEmit: true, skipLibCheck: true, types: [] };
    const pair = ts.createProgram([defaultEntry, ctx.sourceFile.fileName], options);
    return { checker: pair.getTypeChecker(), entry: pair.getSourceFile(defaultEntry), variant: pair.getSourceFile(ctx.sourceFile.fileName) };
}

function exportNames(checker: ts.TypeChecker, sourceFile: ts.SourceFile): Set<string> {
    const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
    return new Set(moduleSymbol ? checker.getExportsOfModule(moduleSymbol).map(s => s.name) : []);
}
