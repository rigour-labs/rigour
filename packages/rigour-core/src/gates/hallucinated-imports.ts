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
 * 5. For Go imports: verify relative package paths exist in the project
 * 6. For Ruby/C#: verify relative require/using paths exist
 *
 * Supported languages: JS/TS, Python, Go, Ruby, C#
 *
 * @since v2.16.0
 */

import { Gate, GateContext } from './base.js';
import { Failure, Provenance } from '../types/index.js';
import { FileScanner } from '../utils/scanner.js';
import { Logger } from '../utils/logger.js';
import fs from 'fs-extra';
import path from 'path';

export interface HallucinatedImport {
    file: string;
    line: number;
    importPath: string;
    type: 'relative' | 'package' | 'python' | 'go' | 'ruby' | 'csharp';
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
            patterns: ['**/*.{ts,js,tsx,jsx,py,go,rb,cs}'],
            ignore: [...(context.ignore || []), '**/node_modules/**', '**/dist/**', '**/build/**',
                     '**/.venv/**', '**/venv/**', '**/vendor/**', '**/bin/Debug/**', '**/bin/Release/**', '**/obj/**'],
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
                } else if (ext === '.go') {
                    this.checkGoImports(content, file, context.cwd, projectFiles, hallucinated);
                } else if (ext === '.rb') {
                    this.checkRubyImports(content, file, projectFiles, hallucinated);
                } else if (ext === '.cs') {
                    this.checkCSharpImports(content, file, projectFiles, hallucinated);
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

    /**
     * Check Go imports — verify project-relative package paths exist.
     *
     * Strategy:
     *  1. Skip Go standard library (comprehensive list of 150+ packages)
     *  2. Skip external modules (any path containing a dot → domain name)
     *  3. Parse go.mod for the project module path
     *  4. Only flag imports that match the project module prefix but don't resolve
     *
     * @since v3.0.1 — fixed false positives on Go stdlib (encoding/json, net/http, etc.)
     */
    private checkGoImports(
        content: string, file: string, cwd: string,
        projectFiles: Set<string>, hallucinated: HallucinatedImport[]
    ): void {
        const lines = content.split('\n');
        let inImportBlock = false;

        // Try to read go.mod for the module path
        const goModPath = path.join(cwd, 'go.mod');
        let modulePath: string | null = null;
        try {
            if (fs.pathExistsSync(goModPath)) {
                const goMod = fs.readFileSync(goModPath, 'utf-8');
                const moduleMatch = goMod.match(/^module\s+(\S+)/m);
                if (moduleMatch) modulePath = moduleMatch[1];
            }
        } catch { /* no go.mod — skip project-relative checks entirely */ }

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();

            // Detect import block: import ( ... )
            if (/^import\s*\(/.test(line)) { inImportBlock = true; continue; }
            if (inImportBlock && line === ')') { inImportBlock = false; continue; }

            // Single import: import "path"  or  import alias "path"
            const singleMatch = line.match(/^import\s+(?:\w+\s+)?"([^"]+)"/);
            const blockMatch = inImportBlock ? line.match(/^\s*(?:\w+\s+)?"([^"]+)"/) : null;
            const importPath = singleMatch?.[1] || blockMatch?.[1];
            if (!importPath) continue;

            // 1. Skip Go standard library — comprehensive list
            if (this.isGoStdlib(importPath)) continue;

            // 2. If we have a module path, check project-relative imports FIRST
            //    (project imports like github.com/myorg/project/pkg also have dots)
            if (modulePath && importPath.startsWith(modulePath + '/')) {
                const relPath = importPath.slice(modulePath.length + 1);
                const hasMatchingFile = [...projectFiles].some(f =>
                    f.endsWith('.go') && f.startsWith(relPath)
                );
                if (!hasMatchingFile) {
                    hallucinated.push({
                        file, line: i + 1, importPath, type: 'go',
                        reason: `Go import '${importPath}' — package directory '${relPath}' not found in project`,
                    });
                }
                continue;
            }

            // 3. Skip external modules — any import containing a dot is a domain
            //    e.g. github.com/*, google.golang.org/*, go.uber.org/*
            if (importPath.includes('.')) continue;

            // 4. No dots, no go.mod match, not stdlib → likely an internal package
            //    without go.mod context we can't verify, so skip to avoid false positives
        }
    }

    /**
     * Comprehensive Go standard library package list.
     * Includes all packages from Go 1.22+ (latest stable).
     * Go stdlib is identified by having NO dots in the import path.
     * We maintain an explicit list for packages with slashes (e.g. encoding/json).
     *
     * @since v3.0.1
     */
    private isGoStdlib(importPath: string): boolean {
        // Fast check: single-segment packages are always stdlib if no dots
        if (!importPath.includes('/') && !importPath.includes('.')) return true;

        // Check the full path against known stdlib packages with sub-paths
        const topLevel = importPath.split('/')[0];

        // All Go stdlib top-level packages (including those with sub-packages)
        const stdlibTopLevel = new Set([
            // Single-word packages
            'archive', 'bufio', 'builtin', 'bytes', 'cmp', 'compress',
            'container', 'context', 'crypto', 'database', 'debug',
            'embed', 'encoding', 'errors', 'expvar', 'flag', 'fmt',
            'go', 'hash', 'html', 'image', 'index', 'io', 'iter',
            'log', 'maps', 'math', 'mime', 'net', 'os', 'path',
            'plugin', 'reflect', 'regexp', 'runtime', 'slices', 'sort',
            'strconv', 'strings', 'structs', 'sync', 'syscall',
            'testing', 'text', 'time', 'unicode', 'unique', 'unsafe',
            // Internal packages (used by stdlib, sometimes by tools)
            'internal', 'vendor',
        ]);

        if (stdlibTopLevel.has(topLevel)) return true;

        // Explicit full-path list for maximum safety — covers all Go 1.22 stdlib paths
        // This catches any edge case the top-level check might miss
        const knownStdlibPaths = new Set([
            // archive/*
            'archive/tar', 'archive/zip',
            // compress/*
            'compress/bzip2', 'compress/flate', 'compress/gzip', 'compress/lzw', 'compress/zlib',
            // container/*
            'container/heap', 'container/list', 'container/ring',
            // crypto/*
            'crypto/aes', 'crypto/cipher', 'crypto/des', 'crypto/dsa',
            'crypto/ecdh', 'crypto/ecdsa', 'crypto/ed25519', 'crypto/elliptic',
            'crypto/hmac', 'crypto/md5', 'crypto/rand', 'crypto/rc4',
            'crypto/rsa', 'crypto/sha1', 'crypto/sha256', 'crypto/sha512',
            'crypto/subtle', 'crypto/tls', 'crypto/x509', 'crypto/x509/pkix',
            // database/*
            'database/sql', 'database/sql/driver',
            // debug/*
            'debug/buildinfo', 'debug/dwarf', 'debug/elf', 'debug/gosym',
            'debug/macho', 'debug/pe', 'debug/plan9obj',
            // encoding/*
            'encoding/ascii85', 'encoding/asn1', 'encoding/base32', 'encoding/base64',
            'encoding/binary', 'encoding/csv', 'encoding/gob', 'encoding/hex',
            'encoding/json', 'encoding/pem', 'encoding/xml',
            // go/*
            'go/ast', 'go/build', 'go/build/constraint', 'go/constant',
            'go/doc', 'go/doc/comment', 'go/format', 'go/importer',
            'go/parser', 'go/printer', 'go/scanner', 'go/token', 'go/types', 'go/version',
            // hash/*
            'hash/adler32', 'hash/crc32', 'hash/crc64', 'hash/fnv', 'hash/maphash',
            // html/*
            'html/template',
            // image/*
            'image/color', 'image/color/palette', 'image/draw',
            'image/gif', 'image/jpeg', 'image/png',
            // index/*
            'index/suffixarray',
            // io/*
            'io/fs', 'io/ioutil',
            // log/*
            'log/slog', 'log/syslog',
            // math/*
            'math/big', 'math/bits', 'math/cmplx', 'math/rand', 'math/rand/v2',
            // mime/*
            'mime/multipart', 'mime/quotedprintable',
            // net/*
            'net/http', 'net/http/cgi', 'net/http/cookiejar', 'net/http/fcgi',
            'net/http/httptest', 'net/http/httptrace', 'net/http/httputil',
            'net/http/pprof', 'net/mail', 'net/netip', 'net/rpc',
            'net/rpc/jsonrpc', 'net/smtp', 'net/textproto', 'net/url',
            // os/*
            'os/exec', 'os/signal', 'os/user',
            // path/*
            'path/filepath',
            // regexp/*
            'regexp/syntax',
            // runtime/*
            'runtime/cgo', 'runtime/coverage', 'runtime/debug', 'runtime/metrics',
            'runtime/pprof', 'runtime/race', 'runtime/trace',
            // sync/*
            'sync/atomic',
            // testing/*
            'testing/fstest', 'testing/iotest', 'testing/quick', 'testing/slogtest',
            // text/*
            'text/scanner', 'text/tabwriter', 'text/template', 'text/template/parse',
            // unicode/*
            'unicode/utf16', 'unicode/utf8',
        ]);

        return knownStdlibPaths.has(importPath);
    }

    /**
     * Check Ruby imports — verify require_relative paths exist
     */
    private checkRubyImports(
        content: string, file: string,
        projectFiles: Set<string>, hallucinated: HallucinatedImport[]
    ): void {
        const lines = content.split('\n');

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();

            // require_relative 'path' — should resolve to a real file
            const relMatch = line.match(/require_relative\s+['"]([^'"]+)['"]/);
            if (relMatch) {
                const reqPath = relMatch[1];
                const dir = path.dirname(file);
                const resolved = path.join(dir, reqPath).replace(/\\/g, '/');
                const candidates = [resolved + '.rb', resolved];
                if (!candidates.some(c => projectFiles.has(c))) {
                    hallucinated.push({
                        file, line: i + 1, importPath: reqPath, type: 'ruby',
                        reason: `require_relative '${reqPath}' — file not found in project`,
                    });
                }
            }
        }
    }

    /**
     * Check C# imports — verify relative using paths match project namespaces
     * (C# uses namespaces, not file paths — we check for obviously wrong namespaces)
     */
    private checkCSharpImports(
        content: string, file: string,
        projectFiles: Set<string>, hallucinated: HallucinatedImport[]
    ): void {
        const lines = content.split('\n');

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();

            // using ProjectName.Something — check if namespace maps to project files
            const usingMatch = line.match(/^using\s+([\w.]+)\s*;/);
            if (!usingMatch) continue;

            const namespace = usingMatch[1];
            // Skip System.* and Microsoft.* and common framework namespaces
            if (/^(?:System|Microsoft|Newtonsoft|NUnit|Xunit|Moq|AutoMapper)\b/.test(namespace)) continue;

            // Check if the namespace maps to any .cs file path in the project
            const nsPath = namespace.replace(/\./g, '/');
            const hasMatch = [...projectFiles].some(f =>
                f.endsWith('.cs') && (f.includes(nsPath) || f.includes(namespace.split('.')[0]))
            );

            // Only flag if the project has NO files that could match this namespace
            if (!hasMatch && namespace.includes('.')) {
                // Could be a NuGet package — we can't verify without .csproj parsing
                // Only flag obvious project-relative namespaces
                const topLevel = namespace.split('.')[0];
                const hasProjectFiles = [...projectFiles].some(f => f.endsWith('.cs') && f.includes(topLevel));
                if (hasProjectFiles) {
                    hallucinated.push({
                        file, line: i + 1, importPath: namespace, type: 'csharp',
                        reason: `Namespace '${namespace}' — no matching files found in project`,
                    });
                }
            }
        }
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
