/**
 * exports/forgotten-type: a package entry exports a function whose signature
 * names a type the entry does not export (api-extractor's "forgotten export").
 *
 * Consumers can call the function but cannot name its parameter or return
 * types, so they cannot annotate, wrap or store the values. TanStack Start's
 * RSC entry exported `renderServerComponent` without the Renderable* types it
 * returns.
 */
import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import type { RuleContext, SemanticFinding, SemanticRule } from '../../types.js';
import { finding } from './shared.js';

const ENTRY = /^index\.[cm]?tsx?$/;

export const exportsForgottenType: SemanticRule = {
    id: 'exports/forgotten-type',
    check(ctx: RuleContext): SemanticFinding[] {
        const { sourceFile, checker } = ctx;
        if (!ENTRY.test(path.basename(sourceFile.fileName)) || !isPackageEntry(ctx)) return [];
        const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
        if (!moduleSymbol) return [];
        const exported = checker.getExportsOfModule(moduleSymbol);
        const exportedTargets = new Set(exported.map(s => resolve(checker, s)));
        // One finding per export statement: the engine keeps one finding per line.
        const missing = new Map<ts.Node, { names: string[]; types: Set<string> }>();
        for (const symbol of exported) {
            for (const declaration of resolve(checker, symbol).declarations ?? []) {
                const fn = functionOf(declaration);
                if (!fn) continue;
                for (const type of signatureTypes(checker, fn)) {
                    if (exportedTargets.has(type) || subpathExports(ctx, type)) continue;
                    const anchor = exportStatementFor(checker, sourceFile, symbol.name) ?? sourceFile.statements[0] ?? sourceFile;
                    const entry = missing.get(anchor) ?? { names: [], types: new Set<string>() };
                    if (!entry.names.includes(symbol.name)) entry.names.push(symbol.name);
                    entry.types.add(type.name);
                    missing.set(anchor, entry);
                }
            }
        }
        const findings: SemanticFinding[] = [];
        for (const [anchor, { names, types }] of missing) {
            const typeList = [...types].map(t => `\`${t}\``).join(', ');
            findings.push(finding(ctx, 'exports/forgotten-type', anchor, 'medium',
                `${names.map(n => `\`${n}\``).join(', ')} ${names.length > 1 ? 'are' : 'is'} exported, but ${types.size > 1 ? 'their signatures use' : 'the signature uses'} ${typeList}, which this entry does not export; consumers cannot name ${types.size > 1 ? 'them' : 'it'}.`,
                `Export ${typeList} (a type-only export is enough) from ${path.basename(sourceFile.fileName)}.`));
        }
        return findings;
    },
};

/** The entry of its package: `index.ts` beside package.json or in its `src/`. */
function isPackageEntry(ctx: RuleContext): boolean {
    // TypeScript names files with '/', path.resolve with the OS separator: compare resolved paths.
    const dir = path.resolve(path.dirname(ctx.sourceFile.fileName));
    const owner = ctx.project.packageDir(ctx.sourceFile.fileName);
    return !!owner && (dir === owner || dir === path.join(owner, 'src'));
}

/**
 * Exported by a subpath entry instead: an `index` file between the type's
 * declaration and the package root that exports it (`pkg/sub` entries).
 */
function subpathExports(ctx: RuleContext, type: ts.Symbol): boolean {
    const owner = ctx.project.packageDir(ctx.sourceFile.fileName);
    const declared = type.declarations?.[0]?.getSourceFile().fileName;
    const self = path.resolve(ctx.sourceFile.fileName);
    if (!owner || !declared) return false;
    for (let dir = path.resolve(path.dirname(declared)); dir.startsWith(owner) && dir !== owner; dir = path.dirname(dir)) {
        const index = ['index.ts', 'index.tsx', 'index.mts'].map(f => path.join(dir, f)).find(f => fs.existsSync(f));
        if (!index || index === self) continue;
        const loaded = ctx.program.getSourceFile(index);
        const moduleSymbol = loaded && ctx.checker.getSymbolAtLocation(loaded);
        if (moduleSymbol ? ctx.checker.getExportsOfModule(moduleSymbol).some(s => s.name === type.name)
            : new RegExp(`\\b${type.name}\\b|export \\*`).test(fs.readFileSync(index, 'utf8'))) return true;
    }
    return false;
}

function resolve(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol {
    return symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

type SignatureOwner = ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression;

/** `function f()` or `const f = () => …` / `const f = function () {…}`. */
function functionOf(declaration: ts.Declaration): SignatureOwner | undefined {
    if (ts.isFunctionDeclaration(declaration)) return declaration;
    const init = ts.isVariableDeclaration(declaration) ? declaration.initializer : undefined;
    return init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) ? init : undefined;
}

/** Project-declared interfaces, type aliases, classes and enums named in parameter and return annotations. */
function signatureTypes(checker: ts.TypeChecker, fn: SignatureOwner): ts.Symbol[] {
    const types: ts.Symbol[] = [];
    const visit = (node: ts.Node): void => {
        if (ts.isTypeReferenceNode(node)) {
            const symbol = checker.getSymbolAtLocation(node.typeName);
            const target = symbol && resolve(checker, symbol);
            if (target && isProjectType(target)) types.push(target);
        }
        ts.forEachChild(node, visit);
    };
    for (const param of fn.parameters) if (param.type) visit(param.type);
    if (fn.type) visit(fn.type);
    return types;
}

function isProjectType(symbol: ts.Symbol): boolean {
    const kinds = ts.SymbolFlags.Interface | ts.SymbolFlags.TypeAlias | ts.SymbolFlags.Class | ts.SymbolFlags.Enum;
    return (symbol.flags & kinds) !== 0
        && (symbol.declarations ?? []).some(d => !d.getSourceFile().isDeclarationFile && !d.getSourceFile().fileName.includes('/node_modules/'));
}

/** The statement that exports `name`: a named export, or the `export *` whose module provides it. */
function exportStatementFor(checker: ts.TypeChecker, sourceFile: ts.SourceFile, name: string): ts.Statement | undefined {
    const declarations = sourceFile.statements.filter(ts.isExportDeclaration);
    const named = declarations.find(s => s.exportClause && ts.isNamedExports(s.exportClause)
        && s.exportClause.elements.some(e => e.name.text === name));
    if (named) return named;
    return declarations.find(s => !s.exportClause && s.moduleSpecifier && providesName(checker, s.moduleSpecifier, name));
}

function providesName(checker: ts.TypeChecker, specifier: ts.Expression, name: string): boolean {
    const moduleSymbol = checker.getSymbolAtLocation(specifier);
    return !!moduleSymbol && checker.getExportsOfModule(moduleSymbol).some(s => s.name === name);
}
