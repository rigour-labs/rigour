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
 */

import { Gate, GateContext } from '../base.js';
import { Failure, Provenance } from '../../types/index.js';
import { FileScanner } from '../../utils/scanner.js';
import { Logger } from '../../utils/logger.js';
import { languageAdapters } from '../language-adapters/index.js';
import fs from 'fs-extra';
import path from 'path';
import { isNodeBuiltin, isPythonStdlib } from '../hallucinated-imports-stdlib.js';
import { checkGoImports, checkRubyImports, checkCSharpImports, checkRustImports, checkJavaKotlinImports } from '../hallucinated-imports-lang.js';
import { checkJSImports, collectJSImportSpecs } from './js-resolver.js';
import { checkPyImports } from './python-resolver.js';
import { discoverWorkspacePackages, loadPackageJson } from './manifest-discovery.js';

export interface HallucinatedImport {
    file: string;
    line: number;
    importPath: string;
    type: 'relative' | 'package' | 'python' | 'go' | 'ruby' | 'csharp' | 'rust' | 'java' | 'kotlin';
    reason: string;
}

export interface HallucinatedImportsConfig {
    enabled?: boolean;
    check_relative?: boolean;
    check_packages?: boolean;
    ignore_patterns?: string[];
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
                     '**/target/debug/**', '**/target/release/**',
                     '**/out/**', '**/.gradle/**', '**/gradle/**'],
        });
        const analyzableFiles = files.filter(file => !this.shouldSkipFile(file));

        Logger.info(`Hallucinated Imports: Scanning ${analyzableFiles.length} files`);

        const projectFiles = new Set(analyzableFiles.map(f => f.replace(/\\/g, '/')));
        const allProjectFiles = new Set(files.map(f => f.replace(/\\/g, '/')));
        const packageJson = await loadPackageJson(context.cwd);
        const rootDeps = new Set([
            ...Object.keys(packageJson?.dependencies || {}),
            ...Object.keys(packageJson?.devDependencies || {}),
            ...Object.keys(packageJson?.peerDependencies || {}),
            ...Object.keys(packageJson?.optionalDependencies || {}),
        ]);

        const workspacePackages = await discoverWorkspacePackages(context.cwd, allProjectFiles);
        for (const wp of workspacePackages) rootDeps.add(wp);

        const depCacheByDir = new Map<string, Set<string>>();
        const tsPathCacheByDir = new Map<string, any>();

        const hasNodeModules = await fs.pathExists(path.join(context.cwd, 'node_modules'));

        for (const file of analyzableFiles) {
            try {
                const fullPath = path.join(context.cwd, file);
                const content = await fs.readFile(fullPath, 'utf-8');
                const ext = path.extname(file);
                const adapter = languageAdapters.getAdapter(file);
                if (!adapter) continue;

                switch (adapter.id) {
                    case 'js':
                        await checkJSImports(
                            content, file, context.cwd, projectFiles, rootDeps,
                            depCacheByDir, hasNodeModules, hallucinated, tsPathCacheByDir,
                            (importPath) => this.shouldIgnore(importPath),
                            (resolvedPath) => this.buildImportCandidates(resolvedPath),
                            (fromFile, importPath, files) => this.resolveRelativeImport(fromFile, importPath, files),
                            (importPath) => this.extractPackageName(importPath)
                        );
                        break;
                    case 'python':
                        await checkPyImports(content, file, context.cwd, projectFiles, hallucinated);
                        break;
                    case 'go':
                        checkGoImports(content, file, context.cwd, projectFiles, hallucinated);
                        break;
                    case 'ruby':
                        checkRubyImports(content, file, context.cwd, projectFiles, hallucinated);
                        break;
                    case 'csharp':
                        checkCSharpImports(content, file, context.cwd, projectFiles, hallucinated);
                        break;
                    case 'rust':
                        checkRustImports(content, file, context.cwd, projectFiles, hallucinated);
                        break;
                    case 'java':
                        checkJavaKotlinImports(content, file, ext, context.cwd, projectFiles, hallucinated);
                        break;
                }
            } catch (e) { }
        }

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

    private resolveRelativeImport(fromFile: string, importPath: string, projectFiles: Set<string>): boolean {
        const dir = path.dirname(fromFile);
        const resolved = path.join(dir, importPath).replace(/\\/g, '/');
        const candidates = this.buildImportCandidates(resolved);
        return candidates.some(c => projectFiles.has(c));
    }

    private extractPackageName(importPath: string): string {
        if (importPath.startsWith('@')) {
            const parts = importPath.split('/');
            return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : importPath;
        }
        return importPath.split('/')[0];
    }

    private shouldIgnore(importPath: string): boolean {
        return this.config.ignore_patterns.some(pattern => new RegExp(pattern).test(importPath));
    }

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
