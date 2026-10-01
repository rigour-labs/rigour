/**
 * JavaScript/TypeScript import resolution for hallucinated-imports gate.
 *
 * Handles JS/TS-specific import validation including:
 * - Relative imports with file resolution
 * - TypeScript path alias resolution (tsconfig.json)
 * - Workspace package discovery (pnpm, npm, yarn, lerna)
 * - Node.js builtin checking
 * - node_modules dependency verification
 */

import fs from 'fs-extra';
import path from 'path';
import ts from 'typescript';
import { HallucinatedImport } from './index.js';
import { isNodeBuiltin } from '../hallucinated-imports-stdlib.js';
import { resolveTsPathTarget } from './ts-path-target.js';
import { isNuxtProvided, isSvelteKitProvided, resolveSvelteKitLib, type NuxtRoots, type SvelteKitRoots } from './framework-modules.js';
import { loadTsPathConfig, type TsPathConfig, type TsPathRule } from './tsconfig-paths.js';

/** Everything a JS/TS import check needs besides the file itself. */
export interface JsImportContext {
    cwd: string;
    projectFiles: Set<string>;
    rootDeps: Set<string>;
    depCacheByDir: Map<string, Set<string>>;
    hasNodeModules: boolean;
    hallucinated: HallucinatedImport[];
    tsPathCacheByDir: Map<string, TsPathConfig | null>;
    kitRoots: SvelteKitRoots;
    nuxtRoots?: NuxtRoots;
    shouldIgnore: (importPath: string) => boolean;
    resolveRelativeImport: (fromFile: string, importPath: string, projectFiles: Set<string>) => boolean;
    extractPackageName: (importPath: string) => string;
}

/**
 * Check JavaScript/TypeScript imports in a source file and add hallucinated findings.
 */
export async function checkJSImports(content: string, file: string, ctx: JsImportContext): Promise<void> {
    const depsForFile = await resolveJSDepsForFile(file, ctx.cwd, ctx.rootDeps, ctx.depCacheByDir);
    const kitRoot = await ctx.kitRoots.rootFor(file);
    const nuxtRoot = await ctx.nuxtRoots?.rootFor(file);
    const typeOnly = typeOnlySpecifiers(content, file);

    for (const spec of collectJSImportSpecs(content, file)) {
        const { line } = spec;
        const importPath = bundlerSpecifier(spec.importPath);
        if (!importPath || ctx.shouldIgnore(importPath)) continue;
        if (kitRoot && isSvelteKitProvided(importPath)) continue;
        if (nuxtRoot && isNuxtProvided(importPath, ctx.extractPackageName(importPath))) continue;

        const reason = importPath.startsWith('.')
            ? await checkRelativeImport(file, importPath, ctx)
            : await checkBareImport(file, importPath, depsForFile, kitRoot, ctx, typeOnly.has(spec.importPath));
        if (reason) {
            ctx.hallucinated.push({
                file, line, importPath,
                type: importPath.startsWith('.') ? 'relative' : 'package',
                reason,
            });
        }
    }
}

/** Specifiers imported only for types: `import type`, `export type … from`, or anything in a .d.ts file. */
export function typeOnlySpecifiers(content: string, file: string): Set<string> {
    const all = /\.d\.[cm]?ts$/.test(file);
    const specs = new Set<string>();
    const pattern = all
        ? /(?:import|export)[^;]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g
        : /(?:import|export)\s+type\s[^;]*?from\s*['"]([^'"]+)['"]/g;
    for (const match of content.matchAll(pattern)) specs.add(match[1] ?? match[2]);
    return specs;
}

/** `@types/x` for `x`; `@types/scope__x` for `@scope/x`. */
export function typesPackageFor(pkgName: string): string {
    return pkgName.startsWith('@') ? `@types/${pkgName.slice(1).replace('/', '__')}` : `@types/${pkgName}`;
}

/**
 * Bundler conventions: a query on a relative import (`./logo.svg?raw`, `./worker.ts?worker`)
 * names a transform of that file, so the file is what must exist; a `virtual:` module or a
 * bare specifier with a query (`page.tsx?tsr-split=component`) is produced by a plugin at
 * build time and cannot be checked. Returns the path to check, or null to skip.
 */
export function bundlerSpecifier(importPath: string): string | null {
    if (!importPath || importPath.startsWith('virtual:') || importPath.startsWith('\0')) return null;
    const query = importPath.search(/[?#]/);
    if (query < 0) return importPath;
    return importPath.startsWith('.') ? importPath.slice(0, query) : null;
}

async function checkRelativeImport(file: string, importPath: string, ctx: JsImportContext): Promise<string | null> {
    if (ctx.resolveRelativeImport(file, importPath, ctx.projectFiles)) return null;
    const config = await resolveTsPathConfigForFile(file, ctx.cwd, ctx.tsPathCacheByDir);
    if (config?.rootDirs.length && await resolveThroughRootDirs(file, importPath, config.rootDirs, ctx)) return null;
    return `File not found: ${importPath}`;
}

/**
 * tsconfig `rootDirs`: directories merged into one virtual root, so
 * `./$types` next to `src/routes/+page.ts` can live in
 * `.svelte-kit/types/src/routes/$types.d.ts`. Generated folders are often
 * git-ignored and absent from the file list, so resolution checks the disk.
 */
async function resolveThroughRootDirs(file: string, importPath: string, rootDirs: string[], ctx: JsImportContext): Promise<boolean> {
    const target = path.resolve(path.dirname(path.resolve(ctx.cwd, file)), importPath);
    for (const root of rootDirs) {
        const relative = path.relative(root, target);
        if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
        for (const other of rootDirs) {
            if (other !== root && await resolveTsPathTarget(other, relative, ctx.cwd, ctx.projectFiles)) return true;
        }
    }
    return false;
}

/** Reason the bare import is hallucinated, or null when it resolves. */
async function checkBareImport(
    file: string,
    importPath: string,
    depsForFile: Set<string>,
    kitRoot: string | null,
    ctx: JsImportContext,
    typeOnly = false,
): Promise<string | null> {
    const aliasResolution = await resolveTsPathAlias(file, importPath, ctx.cwd, ctx.projectFiles, ctx.tsPathCacheByDir);
    if (aliasResolution === true) return null;
    if (aliasResolution === false) return `Path alias '${importPath}' does not resolve to a project file`;

    if (kitRoot) {
        const lib = await resolveSvelteKitLib(importPath, kitRoot, ctx.cwd, ctx.projectFiles);
        if (lib === true) return null;
        if (lib === false) return `Path alias '${importPath}' does not resolve to a file under src/lib`;
    }

    const pkgName = ctx.extractPackageName(importPath);
    if (isNodeBuiltin(pkgName) || depsForFile.has(pkgName)) return null;
    // Types for a package can come from DefinitelyTyped; a type-only import needs nothing at runtime.
    if (typeOnly && depsForFile.has(typesPackageFor(pkgName))) return null;
    if (ctx.hasNodeModules && await fs.pathExists(path.join(ctx.cwd, 'node_modules', pkgName))) return null;
    return `Package '${pkgName}' not in package.json dependencies`;
}

/**
 * Collect all import statements from JavaScript/TypeScript file content.
 * Handles import, export, require(), and dynamic import() statements.
 */
export function collectJSImportSpecs(content: string, file: string): Array<{ importPath: string; line: number }> {
    const sourceFile = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true);
    const specs: Array<{ importPath: string; line: number }> = [];

    const add = (node: ts.Node, value: string) => {
        if (!value) return;
        const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
        specs.push({ importPath: value, line });
    };

    const visit = (node: ts.Node) => {
        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
            add(node, node.moduleSpecifier.text);
        } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
            add(node, node.moduleSpecifier.text);
        } else if (ts.isCallExpression(node)) {
            if (ts.isIdentifier(node.expression) && node.expression.text === 'require') {
                const firstArg = node.arguments[0];
                if (firstArg && ts.isStringLiteral(firstArg)) {
                    add(node, firstArg.text);
                }
            }
            if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
                const firstArg = node.arguments[0];
                if (firstArg && ts.isStringLiteral(firstArg)) {
                    add(node, firstArg.text);
                }
            }
        }
        ts.forEachChild(node, visit);
    };

    ts.forEachChild(sourceFile, visit);
    return specs;
}

/**
 * Resolve JavaScript dependencies for a file by walking up the directory tree
 * to find package.json files and merging their dependencies.
 */
export async function resolveJSDepsForFile(
    file: string,
    cwd: string,
    rootDeps: Set<string>,
    depCacheByDir: Map<string, Set<string>>
): Promise<Set<string>> {
    const rootDir = path.resolve(cwd);
    let currentDir = path.dirname(path.resolve(cwd, file));

    while (currentDir.startsWith(rootDir)) {
        const cached = depCacheByDir.get(currentDir);
        if (cached) return cached;

        const packageJsonPath = path.join(currentDir, 'package.json');
        if (await fs.pathExists(packageJsonPath)) {
            try {
                const packageJson = await fs.readJson(packageJsonPath);
                const deps = new Set([
                    ...rootDeps,
                    ...Object.keys(packageJson?.dependencies || {}),
                    ...Object.keys(packageJson?.devDependencies || {}),
                    ...Object.keys(packageJson?.peerDependencies || {}),
                    ...Object.keys(packageJson?.optionalDependencies || {}),
                ]);
                depCacheByDir.set(currentDir, deps);
                return deps;
            } catch {
                depCacheByDir.set(currentDir, rootDeps);
                return rootDeps;
            }
        }

        const parent = path.dirname(currentDir);
        if (parent === currentDir) break;
        currentDir = parent;
    }

    return rootDeps;
}

/**
 * Resolve TypeScript path aliases from tsconfig.json or jsconfig.json.
 * Returns true if resolved, false if alias exists but doesn't resolve, null if no alias found.
 */
export async function resolveTsPathAlias(
    file: string,
    importPath: string,
    cwd: string,
    projectFiles: Set<string>,
    tsPathCacheByDir: Map<string, TsPathConfig | null>
): Promise<boolean | null> {
    const config = await resolveTsPathConfigForFile(file, cwd, tsPathCacheByDir);
    if (!config || config.rules.length === 0) return null;

    for (const rule of config.rules) {
        const wildcard = matchTsPathRule(rule, importPath);
        if (wildcard === null) continue;

        for (const target of rule.targets) {
            const candidatePattern = rule.hasWildcard ? target.replace('*', wildcard) : target;
            if (await resolveTsPathTarget(config.baseDir, candidatePattern, cwd, projectFiles)) {
                return true;
            }
        }
        return false;
    }

    return null;
}

/**
 * Match a TypeScript path rule against an import path.
 * Returns the wildcard portion if matched, null otherwise.
 */
function matchTsPathRule(rule: TsPathRule, importPath: string): string | null {
    if (!rule.hasWildcard) {
        return importPath === rule.key ? '' : null;
    }
    if (!importPath.startsWith(rule.prefix) || !importPath.endsWith(rule.suffix)) {
        return null;
    }
    return importPath.slice(rule.prefix.length, importPath.length - rule.suffix.length);
}

/**
 * Find and load TypeScript/JavaScript config for a file.
 * Walks up the directory tree to find tsconfig.json or jsconfig.json.
 */
async function resolveTsPathConfigForFile(
    file: string,
    cwd: string,
    tsPathCacheByDir: Map<string, TsPathConfig | null>
): Promise<TsPathConfig | null> {
    const rootDir = path.resolve(cwd);
    let currentDir = path.dirname(path.resolve(cwd, file));

    while (currentDir.startsWith(rootDir)) {
        if (tsPathCacheByDir.has(currentDir)) {
            const cached = tsPathCacheByDir.get(currentDir) || null;
            if (cached) return cached;
        } else {
            const config = await loadTsPathConfig(currentDir);
            tsPathCacheByDir.set(currentDir, config);
            if (config) return config;
        }

        const parent = path.dirname(currentDir);
        if (parent === currentDir) break;
        currentDir = parent;
    }

    return null;
}
