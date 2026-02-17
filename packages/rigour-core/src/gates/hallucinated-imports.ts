/**
 * Hallucinated Imports Gate
 *
 * Detects imports that reference modules which don't exist in the project.
 * This is an AI-specific failure mode — LLMs confidently generate import
 * statements for packages, files, or modules that were never installed
 * or created.
 *
 * Detection strategy:
 * 1. Parse all import/require statements
 * 2. For relative imports: verify the target file exists
 * 3. For package imports: verify the package exists in node_modules or package.json
 * 4. For Python imports: verify the module exists in the project or site-packages
 *
 * @since v2.16.0
 */

import { Gate, GateContext } from './base.js';
import { Failure } from '../types/index.js';
import { FileScanner } from '../utils/scanner.js';
import { Logger } from '../utils/logger.js';
import fs from 'fs-extra';
import path from 'path';

export interface HallucinatedImport {
    file: string;
    line: number;
    importPath: string;
    type: 'relative' | 'package' | 'python';
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

    async run(context: GateContext): Promise<Failure[]> {
        if (!this.config.enabled) return [];

        const failures: Failure[] = [];
        const hallucinated: HallucinatedImport[] = [];

        const files = await FileScanner.findFiles({
            cwd: context.cwd,
            patterns: ['**/*.{ts,js,tsx,jsx,py}'],
            ignore: [...(context.ignore || []), '**/node_modules/**', '**/dist/**', '**/build/**', '**/.venv/**'],
        });

        Logger.info(`Hallucinated Imports: Scanning ${files.length} files`);

        // Build lookup sets for fast resolution
        const projectFiles = new Set(files.map(f => f.replace(/\\/g, '/')));
        const packageJson = await this.loadPackageJson(context.cwd);
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
                            if (this.isNodeBuiltin(pkgName)) continue;

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
            if (this.isPythonStdlib(modulePath)) continue;

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

    private isNodeBuiltin(name: string): boolean {
        const builtins = new Set([
            'assert', 'buffer', 'child_process', 'cluster', 'console', 'constants',
            'crypto', 'dgram', 'dns', 'domain', 'events', 'fs', 'http', 'http2',
            'https', 'inspector', 'module', 'net', 'os', 'path', 'perf_hooks',
            'process', 'punycode', 'querystring', 'readline', 'repl', 'stream',
            'string_decoder', 'sys', 'timers', 'tls', 'trace_events', 'tty',
            'url', 'util', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib',
            'node:assert', 'node:buffer', 'node:child_process', 'node:cluster',
            'node:console', 'node:constants', 'node:crypto', 'node:dgram',
            'node:dns', 'node:domain', 'node:events', 'node:fs', 'node:http',
            'node:http2', 'node:https', 'node:inspector', 'node:module', 'node:net',
            'node:os', 'node:path', 'node:perf_hooks', 'node:process',
            'node:punycode', 'node:querystring', 'node:readline', 'node:repl',
            'node:stream', 'node:string_decoder', 'node:sys', 'node:timers',
            'node:tls', 'node:trace_events', 'node:tty', 'node:url', 'node:util',
            'node:v8', 'node:vm', 'node:wasi', 'node:worker_threads', 'node:zlib',
            'fs-extra', // common enough to skip
        ]);
        return builtins.has(name) || name.startsWith('node:');
    }

    private isPythonStdlib(modulePath: string): boolean {
        const topLevel = modulePath.split('.')[0];
        const stdlibs = new Set([
            'abc', 'aifc', 'argparse', 'array', 'ast', 'asyncio', 'atexit',
            'base64', 'bdb', 'binascii', 'binhex', 'bisect', 'builtins',
            'calendar', 'cgi', 'cgitb', 'chunk', 'cmath', 'cmd', 'code',
            'codecs', 'codeop', 'collections', 'colorsys', 'compileall',
            'concurrent', 'configparser', 'contextlib', 'contextvars', 'copy',
            'copyreg', 'cProfile', 'csv', 'ctypes', 'curses', 'dataclasses',
            'datetime', 'dbm', 'decimal', 'difflib', 'dis', 'distutils',
            'doctest', 'email', 'encodings', 'enum', 'errno', 'faulthandler',
            'fcntl', 'filecmp', 'fileinput', 'fnmatch', 'fractions', 'ftplib',
            'functools', 'gc', 'getopt', 'getpass', 'gettext', 'glob', 'grp',
            'gzip', 'hashlib', 'heapq', 'hmac', 'html', 'http', 'idlelib',
            'imaplib', 'imghdr', 'importlib', 'inspect', 'io', 'ipaddress',
            'itertools', 'json', 'keyword', 'lib2to3', 'linecache', 'locale',
            'logging', 'lzma', 'mailbox', 'mailcap', 'marshal', 'math',
            'mimetypes', 'mmap', 'modulefinder', 'multiprocessing', 'netrc',
            'nis', 'nntplib', 'numbers', 'operator', 'optparse', 'os',
            'ossaudiodev', 'parser', 'pathlib', 'pdb', 'pickle', 'pickletools',
            'pipes', 'pkgutil', 'platform', 'plistlib', 'poplib', 'posix',
            'posixpath', 'pprint', 'profile', 'pstats', 'pty', 'pwd', 'py_compile',
            'pyclbr', 'pydoc', 'queue', 'quopri', 'random', 're', 'readline',
            'reprlib', 'resource', 'rlcompleter', 'runpy', 'sched', 'secrets',
            'select', 'selectors', 'shelve', 'shlex', 'shutil', 'signal',
            'site', 'smtpd', 'smtplib', 'sndhdr', 'socket', 'socketserver',
            'spwd', 'sqlite3', 'sre_compile', 'sre_constants', 'sre_parse',
            'ssl', 'stat', 'statistics', 'string', 'stringprep', 'struct',
            'subprocess', 'sunau', 'symtable', 'sys', 'sysconfig', 'syslog',
            'tabnanny', 'tarfile', 'telnetlib', 'tempfile', 'termios', 'test',
            'textwrap', 'threading', 'time', 'timeit', 'tkinter', 'token',
            'tokenize', 'tomllib', 'trace', 'traceback', 'tracemalloc', 'tty',
            'turtle', 'turtledemo', 'types', 'typing', 'unicodedata', 'unittest',
            'urllib', 'uu', 'uuid', 'venv', 'warnings', 'wave', 'weakref',
            'webbrowser', 'winreg', 'winsound', 'wsgiref', 'xdrlib', 'xml',
            'xmlrpc', 'zipapp', 'zipfile', 'zipimport', 'zlib',
            '_thread', '__future__', '__main__',
        ]);
        return stdlibs.has(topLevel);
    }

    private async loadPackageJson(cwd: string): Promise<any> {
        try {
            const pkgPath = path.join(cwd, 'package.json');
            if (await fs.pathExists(pkgPath)) {
                return await fs.readJson(pkgPath);
            }
        } catch (e) { }
        return null;
    }
}
