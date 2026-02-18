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

        const files = await FileScanner.findFiles({
            cwd: context.cwd,
            patterns: ['**/*.{ts,js,tsx,jsx,py,go,rb,cs,rs,java,kt}'],
            ignore: [...(context.ignore || []), '**/node_modules/**', '**/dist/**', '**/build/**',
                     '**/.venv/**', '**/venv/**', '**/vendor/**', '**/bin/Debug/**', '**/bin/Release/**', '**/obj/**',
                     '**/target/debug/**', '**/target/release/**', // Rust
                     '**/out/**', '**/.gradle/**', '**/gradle/**'], // Java/Kotlin
        });

        Logger.info(`Hallucinated Imports: Scanning ${files.length} files`);

        // Build lookup sets for fast resolution
        const projectFiles = new Set(files.map(f => f.replace(/\\/g, '/')));
        const packageJson = await loadPackageJson(context.cwd);
        const allDeps = new Set([
            ...Object.keys(packageJson?.dependencies || {}),
            ...Object.keys(packageJson?.devDependencies || {}),
            ...Object.keys(packageJson?.peerDependencies || {}),
        ]);

        // Check if node_modules exists (for package verification)
        const hasNodeModules = await fs.pathExists(path.join(context.cwd, 'node_modules'));

        for (const file of files) {
            try {
                const fullPath = path.join(context.cwd, file);
                const content = await fs.readFile(fullPath, 'utf-8');
                const ext = path.extname(file);

                if (['.ts', '.js', '.tsx', '.jsx'].includes(ext)) {
                    await this.checkJSImports(content, file, context.cwd, projectFiles, allDeps, hasNodeModules, hallucinated);
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
        allDeps: Set<string>,
        hasNodeModules: boolean,
        hallucinated: HallucinatedImport[]
    ): Promise<void> {
        const lines = content.split('\n');

        // Match: import ... from '...', require('...'), import('...')
        const importPatterns = [
            /import\s+(?:{[^}]*}|\*\s+as\s+\w+|\w+(?:\s*,\s*{[^}]*})?)\s+from\s+['"]([^'"]+)['"]/g,
            /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
            /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
            /export\s+(?:{[^}]*}|\*)\s+from\s+['"]([^'"]+)['"]/g,
        ];

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            for (const pattern of importPatterns) {
                pattern.lastIndex = 0;
                let match;
                while ((match = pattern.exec(line)) !== null) {
                    const importPath = match[1];

                    // Skip ignored patterns (assets, etc.)
                    if (this.shouldIgnore(importPath)) continue;

                    if (importPath.startsWith('.')) {
                        // Relative import — check file exists
                        if (this.config.check_relative) {
                            const resolved = this.resolveRelativeImport(file, importPath, projectFiles);
                            if (!resolved) {
                                hallucinated.push({
                                    file, line: i + 1, importPath, type: 'relative',
                                    reason: `File not found: ${importPath}`,
                                });
                            }
                        }
                    } else {
                        // Package import — check it exists
                        if (this.config.check_packages) {
                            const pkgName = this.extractPackageName(importPath);

                            // Skip Node.js built-ins
                            if (isNodeBuiltin(pkgName)) continue;

                            if (!allDeps.has(pkgName)) {
                                // Double-check node_modules if available
                                if (hasNodeModules) {
                                    const pkgPath = path.join(cwd, 'node_modules', pkgName);
                                    if (await fs.pathExists(pkgPath)) continue;
                                }

                                hallucinated.push({
                                    file, line: i + 1, importPath, type: 'package',
                                    reason: `Package '${pkgName}' not in package.json dependencies`,
                                });
                            }
                        }
                    }
                }
            }
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
                // Relative Python import
                const pyFile = modulePath.replace(/\./g, '/') + '.py';
                const pyInit = modulePath.replace(/\./g, '/') + '/__init__.py';
                const fileDir = path.dirname(file);
                const resolved1 = path.join(fileDir, pyFile).replace(/\\/g, '/');
                const resolved2 = path.join(fileDir, pyInit).replace(/\\/g, '/');

                if (!projectFiles.has(resolved1) && !projectFiles.has(resolved2)) {
                    hallucinated.push({
                        file, line: i + 1, importPath: modulePath, type: 'python',
                        reason: `Relative module '${modulePath}' not found in project`,
                    });
                }
            } else {
                // Absolute import — check if it's a project module
                const topLevel = modulePath.split('.')[0];
                const pyFile = topLevel + '.py';
                const pyInit = topLevel + '/__init__.py';

                // If it matches a project file, it's a local import — verify it exists
                const isLocalModule = projectFiles.has(pyFile) || projectFiles.has(pyInit) ||
                    [...projectFiles].some(f => f.startsWith(topLevel + '/'));

                // If not local and not stdlib, we can't easily verify pip packages
                // without a requirements.txt or pyproject.toml check
                if (isLocalModule) {
                    // It's referencing a local module — verify the full path
                    const fullModulePath = modulePath.replace(/\./g, '/');
                    const candidates = [
                        fullModulePath + '.py',
                        fullModulePath + '/__init__.py',
                    ];
                    const exists = candidates.some(c => projectFiles.has(c));
                    if (!exists && modulePath.includes('.')) {
                        // Only flag deep module paths that partially resolve
                        hallucinated.push({
                            file, line: i + 1, importPath: modulePath, type: 'python',
                            reason: `Module '${modulePath}' partially resolves but target not found`,
                        });
                    }
                }
            }
        }
    }

    private resolveRelativeImport(fromFile: string, importPath: string, projectFiles: Set<string>): boolean {
        const dir = path.dirname(fromFile);
        const resolved = path.join(dir, importPath).replace(/\\/g, '/');

        // Try exact match, then common extensions
        const extensions = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
        const indexFiles = extensions.map(ext => `${resolved}/index${ext}`);

        const candidates = [
            ...extensions.map(ext => resolved + ext),
            ...indexFiles,
        ];

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
}
