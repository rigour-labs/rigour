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

interface TsPathRule {
    key: string;
    hasWildcard: boolean;
    prefix: string;
    suffix: string;
    targets: string[];
}

interface TsPathConfig {
    baseDir: string;
    rules: TsPathRule[];
}

/**
 * Check JavaScript/TypeScript imports in a source file and add hallucinated findings.
 */
export async function checkJSImports(
    content: string,
    file: string,
    cwd: string,
    projectFiles: Set<string>,
    rootDeps: Set<string>,
    depCacheByDir: Map<string, Set<string>>,
    hasNodeModules: boolean,
    hallucinated: HallucinatedImport[],
    tsPathCacheByDir: Map<string, TsPathConfig | null>,
    shouldIgnore: (importPath: string) => boolean,
    buildImportCandidates: (resolvedPath: string) => string[],
    resolveRelativeImport: (fromFile: string, importPath: string, projectFiles: Set<string>) => boolean,
    extractPackageName: (importPath: string) => string
): Promise<void> {
    const depsForFile = await resolveJSDepsForFile(file, cwd, rootDeps, depCacheByDir);

    for (const spec of collectJSImportSpecs(content, file)) {
        const { importPath, line } = spec;
        if (!importPath || shouldIgnore(importPath)) continue;

        if (importPath.startsWith('.')) {
            const resolved = resolveRelativeImport(file, importPath, projectFiles);
            if (!resolved) {
                hallucinated.push({
                    file, line, importPath, type: 'relative',
                    reason: `File not found: ${importPath}`,
                });
            }
        } else {
            const aliasResolution = await resolveTsPathAlias(
                file,
                importPath,
                cwd,
                projectFiles,
                tsPathCacheByDir
            );
            if (aliasResolution === true) continue;
            if (aliasResolution === false) {
                hallucinated.push({
                    file, line, importPath, type: 'package',
                    reason: `Path alias '${importPath}' does not resolve to a project file`,
                });
                continue;
            }

            const pkgName = extractPackageName(importPath);
            if (isNodeBuiltin(pkgName)) continue;

            if (!depsForFile.has(pkgName)) {
                if (hasNodeModules) {
                    const pkgPath = path.join(cwd, 'node_modules', pkgName);
                    if (await fs.pathExists(pkgPath)) continue;
                }

                hallucinated.push({
                    file, line, importPath, type: 'package',
                    reason: `Package '${pkgName}' not in package.json dependencies`,
                });
            }
        }
    }
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
            if (resolveTsPathTarget(config.baseDir, candidatePattern, cwd, projectFiles)) {
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
 * Check if a TypeScript path target resolves to an actual project file.
 */
function resolveTsPathTarget(
    baseDir: string,
    candidatePattern: string,
    cwd: string,
    projectFiles: Set<string>
): boolean {
    const absolute = path.resolve(baseDir, candidatePattern);
    const relative = path.relative(cwd, absolute).replace(/\\/g, '/');
    const normalized = relative.replace(/\/$/, '');
    const extensions = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.d.ts'];
    const candidates = [
        ...extensions.map(ext => normalized + ext),
        ...extensions.map(ext => `${normalized}/index${ext}`),
    ];
    return candidates.some(c => projectFiles.has(c));
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

/**
 * Load TypeScript path aliases from tsconfig.json, jsconfig.json, or tsconfig.base.json.
 * Follows the extends chain to merge path mappings.
 */
async function loadTsPathConfig(searchDir: string): Promise<TsPathConfig | null> {
    const candidates = ['tsconfig.json', 'jsconfig.json', 'tsconfig.base.json'];
    for (const configName of candidates) {
        const configPath = path.join(searchDir, configName);
        if (!(await fs.pathExists(configPath))) continue;

        const mergedPaths: Record<string, string[]> = {};
        let baseUrl = '.';
        let resolvedBaseDir = searchDir;
        await resolveExtendsChain(configPath, mergedPaths, (bu) => { baseUrl = bu; }, new Set());

        const parsed = await readLooseJson(configPath);
        const compilerOptions = parsed?.compilerOptions || {};

        if (compilerOptions.paths) {
            for (const [key, value] of Object.entries(compilerOptions.paths)) {
                if (typeof key === 'string' && Array.isArray(value)) {
                    mergedPaths[key] = value as string[];
                }
            }
        }
        if (compilerOptions.baseUrl) baseUrl = compilerOptions.baseUrl;

        if (Object.keys(mergedPaths).length === 0) continue;

        resolvedBaseDir = path.resolve(searchDir, baseUrl);
        const rules: TsPathRule[] = [];

        for (const [key, value] of Object.entries(mergedPaths)) {
            if (typeof key !== 'string' || !Array.isArray(value) || value.length === 0) continue;
            const hasWildcard = key.includes('*');
            const [prefix, suffix = ''] = key.split('*');
            const targets = value.filter(v => typeof v === 'string');
            if (targets.length === 0) continue;
            rules.push({ key, hasWildcard, prefix, suffix, targets });
        }

        if (rules.length === 0) continue;
        return { baseDir: resolvedBaseDir, rules };
    }
    return null;
}

/**
 * Recursively follow tsconfig `extends` chain to collect path mappings.
 */
async function resolveExtendsChain(
    configPath: string,
    mergedPaths: Record<string, string[]>,
    setBaseUrl: (bu: string) => void,
    visited: Set<string>
): Promise<void> {
    const resolved = path.resolve(configPath);
    if (visited.has(resolved)) return;
    visited.add(resolved);

    const parsed = await readLooseJson(configPath);
    if (!parsed) return;

    if (parsed.extends) {
        const extendsPath = typeof parsed.extends === 'string' ? parsed.extends : null;
        if (extendsPath) {
            let resolvedExtends: string;
            if (extendsPath.startsWith('.')) {
                resolvedExtends = path.resolve(path.dirname(configPath), extendsPath);
            } else {
                resolvedExtends = path.resolve(path.dirname(configPath), 'node_modules', extendsPath);
            }
            if (!resolvedExtends.endsWith('.json')) {
                const withJson = resolvedExtends + '.json';
                if (await fs.pathExists(withJson)) {
                    resolvedExtends = withJson;
                }
            }
            if (await fs.pathExists(resolvedExtends)) {
                await resolveExtendsChain(resolvedExtends, mergedPaths, setBaseUrl, visited);
            }
        }
    }

    const compilerOptions = parsed.compilerOptions || {};
    if (compilerOptions.baseUrl) {
        setBaseUrl(compilerOptions.baseUrl);
    }
    if (compilerOptions.paths) {
        for (const [key, value] of Object.entries(compilerOptions.paths)) {
            if (typeof key === 'string' && Array.isArray(value)) {
                mergedPaths[key] = value as string[];
            }
        }
    }
}

/**
 * Read JSON file with support for comments and trailing commas.
 */
async function readLooseJson(filePath: string): Promise<any | null> {
    try {
        const text = await fs.readFile(filePath, 'utf-8');
        try {
            return JSON.parse(text);
        } catch {
            const noBlockComments = text.replace(/\/\*[\s\S]*?\*\//g, '');
            const noLineComments = noBlockComments.replace(/(^|\s)\/\/.*$/gm, '$1');
            const noTrailingCommas = noLineComments.replace(/,\s*([}\]])/g, '$1');
            return JSON.parse(noTrailingCommas);
        }
    } catch {
        return null;
    }
}
