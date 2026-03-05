/**
 * Hallucinated Imports Gate
 *
 * Detects imports that reference modules which don't exist in the project.
 * This is an AI-specific failure mode — LLMs confidently generate import
 * statements for packages, files, or modules that were never installed
 * or created.
 *
 * Supported languages (v3.0.1):
 *   JS/TS  — package.json deps, node_modules fallback, Node.js builtins (22.x)
 *   Python — stdlib whitelist (3.12+), relative imports, local module resolution
 *   Go     — stdlib whitelist (1.22+), go.mod module path, aliased imports
 *   Ruby   — stdlib whitelist (3.3+), Gemfile parsing, require + require_relative
 *   C#     — .NET 8 framework namespaces, .csproj NuGet parsing, using directives
 *   Rust   — std/core/alloc crates, Cargo.toml deps, use/extern crate statements
 *   Java   — java/javax/jakarta stdlib, build.gradle + pom.xml deps, import statements
 *   Kotlin — kotlin/kotlinx stdlib, Gradle deps, import statements
 *
 * @since v2.16.0
 * @since v3.0.1 — Go stdlib fix, Ruby/C# strengthened, Rust/Java/Kotlin added
 */

import { Gate, GateContext } from './base.js';
import { Failure, Provenance } from '../types/index.js';
import { FileScanner } from '../utils/scanner.js';
import { Logger } from '../utils/logger.js';
import fs from 'fs-extra';
import path from 'path';
import ts from 'typescript';
import { isNodeBuiltin, isPythonStdlib } from './hallucinated-imports-stdlib.js';
import { checkGoImports, checkRubyImports, checkCSharpImports, checkRustImports, checkJavaKotlinImports, loadPackageJson } from './hallucinated-imports-lang.js';

export interface HallucinatedImport {
    file: string;
    line: number;
    importPath: string;
    type: 'relative' | 'package' | 'python' | 'go' | 'ruby' | 'csharp' | 'rust' | 'java' | 'kotlin';
    reason: string;
}

export interface HallucinatedImportsConfig {
    enabled?: boolean;
    check_relative?: boolean;    // Check relative imports resolve to real files
    check_packages?: boolean;    // Check npm/pip packages exist
    ignore_patterns?: string[];  // Import patterns to ignore (e.g. asset imports)
}

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

export class HallucinatedImportsGate extends Gate {
    private config: Required<Omit<HallucinatedImportsConfig, 'ignore_patterns'>> & { ignore_patterns: string[] };

    constructor(config: HallucinatedImportsConfig = {}) {
        super('hallucinated-imports', 'Hallucinated Import Detection');
        this.config = {
            enabled: config.enabled ?? true,
            check_relative: config.check_relative ?? true,
            check_packages: config.check_packages ?? true,
            ignore_patterns: config.ignore_patterns ?? [
                '\\.css$', '\\.scss$', '\\.less$', '\\.svg$', '\\.png$', '\\.jpg$',
                '\\.json$', '\\.wasm$', '\\.graphql$', '\\.gql$',
            ],
        };
    }

    protected get provenance(): Provenance { return 'ai-drift'; }

    async run(context: GateContext): Promise<Failure[]> {
        if (!this.config.enabled) return [];

        const failures: Failure[] = [];
        const hallucinated: HallucinatedImport[] = [];

        const defaultPatterns = ['**/*.{ts,js,tsx,jsx,py,go,rb,cs,rs,java,kt}'];
        const scanPatterns = context.patterns || defaultPatterns;
        const files = await FileScanner.findFiles({
            cwd: context.cwd,
            patterns: scanPatterns,
            ignore: [...(context.ignore || []), '**/node_modules/**', '**/dist/**', '**/build/**',
                     '**/examples/**',
                     '**/studio-dist/**', '**/.next/**', '**/coverage/**',
                     '**/*.test.*', '**/*.spec.*', '**/__tests__/**',
                     '**/.venv/**', '**/venv/**', '**/vendor/**', '**/bin/Debug/**', '**/bin/Release/**', '**/obj/**',
                     '**/target/debug/**', '**/target/release/**', // Rust
                     '**/out/**', '**/.gradle/**', '**/gradle/**'], // Java/Kotlin
        });
        const analyzableFiles = files.filter(file => !this.shouldSkipFile(file));

        Logger.info(`Hallucinated Imports: Scanning ${analyzableFiles.length} files`);

        // Build lookup sets for fast resolution
        const projectFiles = new Set(analyzableFiles.map(f => f.replace(/\\/g, '/')));
        const packageJson = await loadPackageJson(context.cwd);
        const rootDeps = new Set([
            ...Object.keys(packageJson?.dependencies || {}),
            ...Object.keys(packageJson?.devDependencies || {}),
            ...Object.keys(packageJson?.peerDependencies || {}),
            ...Object.keys(packageJson?.optionalDependencies || {}),
        ]);
        const depCacheByDir = new Map<string, Set<string>>();
        const tsPathCacheByDir = new Map<string, TsPathConfig | null>();

        // Check if node_modules exists (for package verification)
        const hasNodeModules = await fs.pathExists(path.join(context.cwd, 'node_modules'));

        for (const file of analyzableFiles) {
            try {
                const fullPath = path.join(context.cwd, file);
                const content = await fs.readFile(fullPath, 'utf-8');
                const ext = path.extname(file);

                if (['.ts', '.js', '.tsx', '.jsx'].includes(ext)) {
                    await this.checkJSImports(content, file, context.cwd, projectFiles, rootDeps, depCacheByDir, hasNodeModules, hallucinated, tsPathCacheByDir);
                } else if (ext === '.py') {
                    await this.checkPyImports(content, file, context.cwd, projectFiles, hallucinated);
                } else if (ext === '.go') {
                    checkGoImports(content, file, context.cwd, projectFiles, hallucinated);
                } else if (ext === '.rb') {
                    checkRubyImports(content, file, context.cwd, projectFiles, hallucinated);
                } else if (ext === '.cs') {
                    checkCSharpImports(content, file, context.cwd, projectFiles, hallucinated);
                } else if (ext === '.rs') {
                    checkRustImports(content, file, context.cwd, projectFiles, hallucinated);
                } else if (ext === '.java' || ext === '.kt') {
                    checkJavaKotlinImports(content, file, ext, context.cwd, projectFiles, hallucinated);
                }
            } catch (e) { }
        }

        // Group hallucinated imports by file for cleaner output
        const byFile = new Map<string, HallucinatedImport[]>();
        for (const h of hallucinated) {
            const existing = byFile.get(h.file) || [];
            existing.push(h);
            byFile.set(h.file, existing);
        }

        for (const [file, imports] of byFile) {
            const details = imports.map(i => `  L${i.line}: import '${i.importPath}' — ${i.reason}`).join('\n');

            failures.push(this.createFailure(
                `Hallucinated imports in ${file}:\n${details}`,
                [file],
                `These imports reference modules that don't exist. Remove or replace with real modules. AI models often "hallucinate" package names or file paths.`,
                'Hallucinated Imports',
                imports[0].line,
                undefined,
                'critical'
            ));
        }

        return failures;
    }

    private async checkJSImports(
        content: string,
        file: string,
        cwd: string,
        projectFiles: Set<string>,
        rootDeps: Set<string>,
        depCacheByDir: Map<string, Set<string>>,
        hasNodeModules: boolean,
        hallucinated: HallucinatedImport[],
        tsPathCacheByDir: Map<string, TsPathConfig | null>
    ): Promise<void> {
        const depsForFile = await this.resolveJSDepsForFile(file, cwd, rootDeps, depCacheByDir);

        for (const spec of this.collectJSImportSpecs(content, file)) {
            const { importPath, line } = spec;
            if (!importPath || this.shouldIgnore(importPath)) continue;

            if (importPath.startsWith('.')) {
                if (this.config.check_relative) {
                    const resolved = this.resolveRelativeImport(file, importPath, projectFiles);
                    if (!resolved) {
                        hallucinated.push({
                            file, line, importPath, type: 'relative',
                            reason: `File not found: ${importPath}`,
                        });
                    }
                }
            } else {
                const aliasResolution = await this.resolveTsPathAlias(file, importPath, cwd, projectFiles, tsPathCacheByDir);
                if (aliasResolution === true) continue;
                if (aliasResolution === false) {
                    hallucinated.push({
                        file, line, importPath, type: 'package',
                        reason: `Path alias '${importPath}' does not resolve to a project file`,
                    });
                    continue;
                }

                if (this.config.check_packages) {
                    const pkgName = this.extractPackageName(importPath);
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
    }

    private collectJSImportSpecs(content: string, file: string): Array<{ importPath: string; line: number }> {
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
                // require('x')
                if (ts.isIdentifier(node.expression) && node.expression.text === 'require') {
                    const firstArg = node.arguments[0];
                    if (firstArg && ts.isStringLiteral(firstArg)) {
                        add(node, firstArg.text);
                    }
                }
                // import('x')
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

    private async resolveJSDepsForFile(
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

    private async resolveTsPathAlias(
        file: string,
        importPath: string,
        cwd: string,
        projectFiles: Set<string>,
        tsPathCacheByDir: Map<string, TsPathConfig | null>
    ): Promise<boolean | null> {
        const config = await this.resolveTsPathConfigForFile(file, cwd, tsPathCacheByDir);
        if (!config || config.rules.length === 0) return null;

        for (const rule of config.rules) {
            const wildcard = this.matchTsPathRule(rule, importPath);
            if (wildcard === null) continue;

            for (const target of rule.targets) {
                const candidatePattern = rule.hasWildcard ? target.replace('*', wildcard) : target;
                if (this.resolveTsPathTarget(config.baseDir, candidatePattern, cwd, projectFiles)) {
                    return true;
                }
            }
            return false;
        }

        return null;
    }

    private matchTsPathRule(rule: TsPathRule, importPath: string): string | null {
        if (!rule.hasWildcard) {
            return importPath === rule.key ? '' : null;
        }
        if (!importPath.startsWith(rule.prefix) || !importPath.endsWith(rule.suffix)) {
            return null;
        }
        return importPath.slice(rule.prefix.length, importPath.length - rule.suffix.length);
    }

    private resolveTsPathTarget(
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

    private async resolveTsPathConfigForFile(
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
                const config = await this.loadTsPathConfig(currentDir);
                tsPathCacheByDir.set(currentDir, config);
                if (config) return config;
            }

            const parent = path.dirname(currentDir);
            if (parent === currentDir) break;
            currentDir = parent;
        }

        return null;
    }

    private async loadTsPathConfig(searchDir: string): Promise<TsPathConfig | null> {
        const candidates = ['tsconfig.json', 'jsconfig.json', 'tsconfig.base.json'];
        for (const configName of candidates) {
            const configPath = path.join(searchDir, configName);
            if (!(await fs.pathExists(configPath))) continue;

            const parsed = await this.readLooseJson(configPath);
            const compilerOptions = parsed?.compilerOptions || {};
            const paths = compilerOptions.paths;
            if (!paths || typeof paths !== 'object') continue;

            const baseUrl = typeof compilerOptions.baseUrl === 'string' ? compilerOptions.baseUrl : '.';
            const baseDir = path.resolve(searchDir, baseUrl);
            const rules: TsPathRule[] = [];

            for (const [key, value] of Object.entries(paths)) {
                if (typeof key !== 'string' || !Array.isArray(value) || value.length === 0) continue;
                const hasWildcard = key.includes('*');
                const [prefix, suffix = ''] = key.split('*');
                const targets = value.filter(v => typeof v === 'string');
                if (targets.length === 0) continue;
                rules.push({ key, hasWildcard, prefix, suffix, targets });
            }

            if (rules.length === 0) continue;
            return { baseDir, rules };
        }
        return null;
    }

    private async readLooseJson(filePath: string): Promise<any | null> {
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

    private async checkPyImports(
        content: string,
        file: string,
        cwd: string,
        projectFiles: Set<string>,
        hallucinated: HallucinatedImport[]
    ): Promise<void> {
        const lines = content.split('\n');
        // Lazily resolve Python source roots and installed packages for this project
        const pySourceRoots = await this.findPythonSourceRoots(cwd, projectFiles);
        const pyInstalledPkgs = await this.loadPythonInstalledPackages(cwd);

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();

            // Match: from X import Y, import X
            const fromMatch = line.match(/^from\s+([\w.]+)\s+import/);
            const importMatch = line.match(/^import\s+([\w.]+)/);

            const modulePath = fromMatch?.[1] || importMatch?.[1];
            if (!modulePath) continue;

            // Skip standard library modules
            if (isPythonStdlib(modulePath)) continue;

            // Check if it's a relative project import
            if (modulePath.startsWith('.')) {
                // Python relative import: count leading dots to determine traversal depth.
                // N dots = go up (N-1) package levels from the file's directory.
                //   from .types import X      → 1 dot = current package (0 levels up)
                //   from ..types import X     → 2 dots = parent package (1 level up)
                //   from ...client import X   → 3 dots = grandparent package (2 levels up)
                const dotMatch = modulePath.match(/^(\.+)/);
                const dotCount = dotMatch ? dotMatch[1].length : 0;
                const moduleRest = modulePath.slice(dotCount); // e.g. 'client', 'types', 'models.permission', or '' for bare dots

                // Walk up (dotCount - 1) directories from the file's directory
                let baseDir = path.dirname(file);
                for (let level = 1; level < dotCount; level++) {
                    const parent = path.dirname(baseDir);
                    if (parent === baseDir) break; // at root
                    baseDir = parent;
                }

                // If moduleRest is empty (e.g. `from . import X`), we're just referencing the package directory.
                // The imported names come from the `import` clause, not the module path — skip validation
                // since bare-dot package references are almost never hallucinated.
                if (!moduleRest) continue;

                // Resolve remaining module path within the target directory
                const moduleParts = moduleRest.replace(/\./g, '/');
                const candidateBase = path.join(baseDir, moduleParts).replace(/\\/g, '/');

                const candidates = [
                    candidateBase + '.py',
                    candidateBase + '/__init__.py',
                ];

                if (!candidates.some(c => projectFiles.has(c))) {
                    hallucinated.push({
                        file, line: i + 1, importPath: modulePath, type: 'python',
                        reason: `Relative module '${modulePath}' not found in project`,
                    });
                }
            } else {
                // Absolute import — check if it's a project module or installed package
                const topLevel = modulePath.split('.')[0];

                // Check if this is an installed package (from pyproject.toml, requirements.txt, etc.)
                if (pyInstalledPkgs.has(topLevel) || pyInstalledPkgs.has(topLevel.replace(/_/g, '-'))) {
                    continue; // Known installed package — skip
                }

                // Check if it's a local module (searching across all Python source roots)
                let foundLocal = false;
                const searchRoots = ['', ...pySourceRoots]; // '' = project root

                for (const root of searchRoots) {
                    const prefix = root ? root + '/' : '';
                    const pyFile = prefix + topLevel + '.py';
                    const pyInit = prefix + topLevel + '/__init__.py';
                    const dirPrefix = prefix + topLevel + '/';

                    const isLocalModule = projectFiles.has(pyFile) || projectFiles.has(pyInit) ||
                        [...projectFiles].some(f => f.startsWith(dirPrefix));

                    if (!isLocalModule) continue;
                    foundLocal = true;

                    // It's referencing a local module — verify the full path
                    const fullModulePath = prefix + modulePath.replace(/\./g, '/');
                    const candidates = [
                        fullModulePath + '.py',
                        fullModulePath + '/__init__.py',
                    ];
                    const exists = candidates.some(c => projectFiles.has(c));
                    if (exists) break; // Found it — no issue

                    if (modulePath.includes('.')) {
                        // Only flag deep module paths that partially resolve
                        hallucinated.push({
                            file, line: i + 1, importPath: modulePath, type: 'python',
                            reason: `Module '${modulePath}' partially resolves but target not found`,
                        });
                    }
                    break;
                }

                // If not local and not stdlib and not installed, we can't easily verify
                // — skip silently rather than risk false positives
            }
        }
    }

    /**
     * Find Python source roots (directories that are on sys.path) by looking at
     * pyproject.toml, setup.cfg, or common patterns like src/ layouts.
     */
    private async findPythonSourceRoots(cwd: string, projectFiles: Set<string>): Promise<string[]> {
        const roots: string[] = [];

        // Check pyproject.toml for package-dir or src layout hints
        const pyprojectPath = path.join(cwd, 'pyproject.toml');
        if (await fs.pathExists(pyprojectPath)) {
            try {
                const content = await fs.readFile(pyprojectPath, 'utf-8');
                // Match [tool.setuptools.packages.find] where = ["src"] or similar
                const whereMatch = content.match(/where\s*=\s*\[\s*"([^"]+)"\s*\]/);
                if (whereMatch) {
                    roots.push(whereMatch[1]);
                }
                // Match package-dir patterns
                const pkgDirMatch = content.match(/package-dir\s*=\s*\{\s*""\s*:\s*"([^"]+)"\s*\}/);
                if (pkgDirMatch) {
                    roots.push(pkgDirMatch[1]);
                }
            } catch { /* skip */ }
        }

        // Common source root patterns
        const commonSrcDirs = ['src', 'lib', 'app'];
        for (const dir of commonSrcDirs) {
            if ([...projectFiles].some(f => f.startsWith(dir + '/') && f.endsWith('.py'))) {
                if (!roots.includes(dir)) {
                    roots.push(dir);
                }
            }
        }

        // Also scan for directories containing __init__.py that aren't at root level
        // (e.g. sdks/sandbox/python/src/ as a source root)
        const pyprojectFiles = [...projectFiles].filter(f => f.endsWith('/pyproject.toml') || f === 'pyproject.toml');
        for (const pf of pyprojectFiles) {
            const pfDir = path.dirname(pf);
            if (pfDir === '.') continue;
            // Check if this pyproject.toml has a src/ dir
            const srcDir = pfDir + '/src';
            if ([...projectFiles].some(f => f.startsWith(srcDir + '/') && f.endsWith('.py'))) {
                if (!roots.includes(srcDir)) {
                    roots.push(srcDir);
                }
            }
        }

        return roots;
    }

    /**
     * Load installed Python package names from pyproject.toml dependencies,
     * requirements.txt, setup.cfg, or Pipfile.
     */
    private async loadPythonInstalledPackages(cwd: string): Promise<Set<string>> {
        const packages = new Set<string>();

        // Helper to normalize package names (PEP 503: lowercase, replace [-_.] with -)
        const normalize = (name: string) => name.toLowerCase().replace(/[-_.]+/g, '-');

        // Check pyproject.toml
        const pyprojectPath = path.join(cwd, 'pyproject.toml');
        if (await fs.pathExists(pyprojectPath)) {
            try {
                const content = await fs.readFile(pyprojectPath, 'utf-8');
                // Match dependencies = ["fastapi>=0.100", "kubernetes", ...]
                const depsMatch = content.match(/dependencies\s*=\s*\[([\s\S]*?)\]/g);
                if (depsMatch) {
                    for (const block of depsMatch) {
                        const pkgs = block.match(/"([^">=<!\s\[]+)/g);
                        if (pkgs) {
                            for (const pkg of pkgs) {
                                const name = pkg.replace(/^"/, '').split(/[>=<!\[]/)[0].trim();
                                if (name && name !== 'dependencies') {
                                    packages.add(normalize(name));
                                    // Also add the import name (replace - with _)
                                    packages.add(name.replace(/-/g, '_').toLowerCase());
                                }
                            }
                        }
                    }
                }
                // optional-dependencies
                const optDepsMatch = content.match(/optional-dependencies\s*\]([\s\S]*?)(?:\n\[|\n$)/);
                if (optDepsMatch) {
                    const pkgs = optDepsMatch[1].match(/"([^">=<!\s\[]+)/g);
                    if (pkgs) {
                        for (const pkg of pkgs) {
                            const name = pkg.replace(/^"/, '').split(/[>=<!\[]/)[0].trim();
                            if (name) {
                                packages.add(normalize(name));
                                packages.add(name.replace(/-/g, '_').toLowerCase());
                            }
                        }
                    }
                }
            } catch { /* skip */ }
        }

        // Check requirements*.txt files
        const reqFiles = ['requirements.txt', 'requirements-dev.txt', 'requirements_dev.txt'];
        for (const reqFile of reqFiles) {
            const reqPath = path.join(cwd, reqFile);
            if (await fs.pathExists(reqPath)) {
                try {
                    const content = await fs.readFile(reqPath, 'utf-8');
                    for (const line of content.split('\n')) {
                        const trimmed = line.trim();
                        if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('-')) continue;
                        const name = trimmed.split(/[>=<!\[;@\s]/)[0].trim();
                        if (name) {
                            packages.add(normalize(name));
                            packages.add(name.replace(/-/g, '_').toLowerCase());
                        }
                    }
                } catch { /* skip */ }
            }
        }

        // Also scan subdirectories for pyproject.toml (monorepo support)
        const subPyprojects = ['server/pyproject.toml', 'api/pyproject.toml', 'backend/pyproject.toml'];
        for (const sub of subPyprojects) {
            const subPath = path.join(cwd, sub);
            if (await fs.pathExists(subPath)) {
                try {
                    const content = await fs.readFile(subPath, 'utf-8');
                    const depsMatch = content.match(/dependencies\s*=\s*\[([\s\S]*?)\]/g);
                    if (depsMatch) {
                        for (const block of depsMatch) {
                            const pkgs = block.match(/"([^">=<!\s\[]+)/g);
                            if (pkgs) {
                                for (const pkg of pkgs) {
                                    const name = pkg.replace(/^"/, '').split(/[>=<!\[]/)[0].trim();
                                    if (name && name !== 'dependencies') {
                                        packages.add(normalize(name));
                                        packages.add(name.replace(/-/g, '_').toLowerCase());
                                    }
                                }
                            }
                        }
                    }
                } catch { /* skip */ }
            }
        }

        return packages;
    }

    private resolveRelativeImport(fromFile: string, importPath: string, projectFiles: Set<string>): boolean {
        const dir = path.dirname(fromFile);
        const resolved = path.join(dir, importPath).replace(/\\/g, '/');
        const candidates = this.buildImportCandidates(resolved);
        return candidates.some(c => projectFiles.has(c));
    }

    private extractPackageName(importPath: string): string {
        // Scoped packages: @scope/package/... → @scope/package
        if (importPath.startsWith('@')) {
            const parts = importPath.split('/');
            return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : importPath;
        }
        // Regular packages: package/... → package
        return importPath.split('/')[0];
    }

    private shouldIgnore(importPath: string): boolean {
        return this.config.ignore_patterns.some(pattern => new RegExp(pattern).test(importPath));
    }

    /**
     * Build candidate source paths for an import.
     * Handles ESM-style TS source imports like "./foo.js" that map to "./foo.ts" pre-build.
     */
    private buildImportCandidates(resolvedPath: string): string[] {
        const extension = path.extname(resolvedPath).toLowerCase();
        const sourceExtensions = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.d.ts'];
        const runtimeExtensions = new Set(['.js', '.jsx', '.mjs', '.cjs']);

        let candidates: string[] = [];
        if (runtimeExtensions.has(extension)) {
            const withoutExt = resolvedPath.slice(0, -extension.length);
            candidates = [
                ...sourceExtensions.map(ext => withoutExt + ext),
                ...sourceExtensions.map(ext => `${withoutExt}/index${ext}`),
                resolvedPath,
                `${resolvedPath}/index`,
            ];
        } else if (extension) {
            candidates = [resolvedPath, `${resolvedPath}/index`];
        } else {
            candidates = [
                ...sourceExtensions.map(ext => resolvedPath + ext),
                ...sourceExtensions.map(ext => `${resolvedPath}/index${ext}`),
            ];
        }

        return [...new Set(candidates)];
    }

    private shouldSkipFile(file: string): boolean {
        const normalized = file.replace(/\\/g, '/');
        return (
            normalized.includes('/examples/') ||
            normalized.includes('/studio-dist/') ||
            normalized.includes('/__tests__/') ||
            /\.test\.[^.]+$/i.test(normalized) ||
            /\.spec\.[^.]+$/i.test(normalized)
        );
    }
}
