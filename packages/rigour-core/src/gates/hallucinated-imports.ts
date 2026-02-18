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
                    this.checkRubyImports(content, file, context.cwd, projectFiles, hallucinated);
                } else if (ext === '.cs') {
                    this.checkCSharpImports(content, file, context.cwd, projectFiles, hallucinated);
                } else if (ext === '.rs') {
                    this.checkRustImports(content, file, context.cwd, projectFiles, hallucinated);
                } else if (ext === '.java' || ext === '.kt') {
                    this.checkJavaKotlinImports(content, file, ext, context.cwd, projectFiles, hallucinated);
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

    /**
     * Node.js built-in modules — covers Node.js 18/20/22 LTS
     * No third-party packages in this list (removed fs-extra hack).
     */
    private isNodeBuiltin(name: string): boolean {
        // Fast path: node: protocol prefix
        if (name.startsWith('node:')) return true;

        const builtins = new Set([
            'assert', 'assert/strict', 'async_hooks', 'buffer', 'child_process',
            'cluster', 'console', 'constants', 'crypto', 'dgram', 'diagnostics_channel',
            'dns', 'dns/promises', 'domain', 'events', 'fs', 'fs/promises',
            'http', 'http2', 'https', 'inspector', 'inspector/promises', 'module',
            'net', 'os', 'path', 'path/posix', 'path/win32', 'perf_hooks',
            'process', 'punycode', 'querystring', 'readline', 'readline/promises',
            'repl', 'stream', 'stream/consumers', 'stream/promises', 'stream/web',
            'string_decoder', 'sys', 'test', 'timers', 'timers/promises',
            'tls', 'trace_events', 'tty', 'url', 'util', 'util/types',
            'v8', 'vm', 'wasi', 'worker_threads', 'zlib',
        ]);
        return builtins.has(name);
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
     * Check Ruby imports — require, require_relative, Gemfile verification
     *
     * Strategy:
     *  1. require_relative: verify target .rb file exists in project
     *  2. require: skip stdlib, skip gems from Gemfile/gemspec, flag unknown local requires
     *
     * @since v3.0.1 — strengthened with stdlib whitelist and Gemfile parsing
     */
    private checkRubyImports(
        content: string, file: string, cwd: string,
        projectFiles: Set<string>, hallucinated: HallucinatedImport[]
    ): void {
        const lines = content.split('\n');

        // Parse Gemfile for known gem dependencies
        const gemDeps = this.loadRubyGems(cwd);

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();

            // Skip comments
            if (line.startsWith('#')) continue;

            // require_relative 'path' — must resolve to a real file
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
                continue;
            }

            // require 'something' — check stdlib, gems, then local
            const reqMatch = line.match(/^require\s+['"]([^'"]+)['"]/);
            if (reqMatch) {
                const reqPath = reqMatch[1];

                // Skip Ruby stdlib
                if (this.isRubyStdlib(reqPath)) continue;

                // Skip gems listed in Gemfile
                const gemName = reqPath.split('/')[0];
                if (gemDeps.has(gemName)) continue;

                // Check if it resolves to a project file
                const candidates = [
                    reqPath + '.rb',
                    reqPath,
                    'lib/' + reqPath + '.rb',
                    'lib/' + reqPath,
                ];
                const found = candidates.some(c => projectFiles.has(c));
                if (!found) {
                    // If we have a Gemfile and it's not in it, it might be hallucinated
                    if (gemDeps.size > 0) {
                        hallucinated.push({
                            file, line: i + 1, importPath: reqPath, type: 'ruby',
                            reason: `require '${reqPath}' — not in stdlib, Gemfile, or project files`,
                        });
                    }
                }
            }
        }
    }

    /** Load gem names from Gemfile */
    private loadRubyGems(cwd: string): Set<string> {
        const gems = new Set<string>();
        try {
            const gemfilePath = path.join(cwd, 'Gemfile');
            if (fs.pathExistsSync(gemfilePath)) {
                const content = fs.readFileSync(gemfilePath, 'utf-8');
                const gemPattern = /gem\s+['"]([^'"]+)['"]/g;
                let m;
                while ((m = gemPattern.exec(content)) !== null) {
                    gems.add(m[1]);
                }
            }
            // Also check .gemspec
            const gemspecs = [...new Set<string>()]; // placeholder
            const files = fs.readdirSync?.(cwd) || [];
            for (const f of files) {
                if (typeof f === 'string' && f.endsWith('.gemspec')) {
                    try {
                        const spec = fs.readFileSync(path.join(cwd, f), 'utf-8');
                        const depPattern = /add_(?:runtime_)?dependency\s+['"]([^'"]+)['"]/g;
                        let dm;
                        while ((dm = depPattern.exec(spec)) !== null) {
                            gems.add(dm[1]);
                        }
                    } catch { /* skip */ }
                }
            }
        } catch { /* no Gemfile */ }
        return gems;
    }

    /**
     * Ruby standard library — covers Ruby 3.3+ (MRI)
     * Includes both the default gems and bundled gems that ship with Ruby.
     */
    private isRubyStdlib(name: string): boolean {
        const topLevel = name.split('/')[0];
        const stdlibs = new Set([
            // Core libs (always available)
            'abbrev', 'base64', 'benchmark', 'bigdecimal', 'cgi', 'csv',
            'date', 'delegate', 'did_you_mean', 'digest', 'drb', 'english',
            'erb', 'error_highlight', 'etc', 'fcntl', 'fiddle', 'fileutils',
            'find', 'forwardable', 'getoptlong', 'io', 'ipaddr', 'irb',
            'json', 'logger', 'matrix', 'minitest', 'monitor', 'mutex_m',
            'net', 'nkf', 'objspace', 'observer', 'open3', 'open-uri',
            'openssl', 'optparse', 'ostruct', 'pathname', 'pp', 'prettyprint',
            'prime', 'pstore', 'psych', 'racc', 'rake', 'rdoc', 'readline',
            'reline', 'resolv', 'resolv-replace', 'rinda', 'ruby2_keywords',
            'rubygems', 'securerandom', 'set', 'shellwords', 'singleton',
            'socket', 'stringio', 'strscan', 'syntax_suggest', 'syslog',
            'tempfile', 'time', 'timeout', 'tmpdir', 'tsort', 'un',
            'unicode_normalize', 'uri', 'weakref', 'yaml', 'zlib',
            // Default gems (ship with Ruby, can be overridden)
            'bundler', 'debug', 'net-ftp', 'net-http', 'net-imap',
            'net-pop', 'net-protocol', 'net-smtp', 'power_assert',
            'test-unit', 'rexml', 'rss', 'typeprof',
            // Common C extensions
            'stringio', 'io/console', 'io/nonblock', 'io/wait',
            'rbconfig', 'mkmf', 'thread',
            // Rails-adjacent but actually stdlib
            'webrick', 'cmath', 'complex', 'rational',
            'coverage', 'ripper', 'win32ole', 'win32api',
        ]);
        return stdlibs.has(topLevel);
    }

    /**
     * Check C# imports — using directives against .NET framework, NuGet, and project
     *
     * Strategy:
     *  1. Skip .NET framework namespaces (System.*, Microsoft.*, etc.)
     *  2. Skip NuGet packages from .csproj PackageReference
     *  3. Flag project-relative namespaces that don't resolve
     *
     * @since v3.0.1 — .csproj NuGet parsing, comprehensive framework namespace list
     */
    private checkCSharpImports(
        content: string, file: string, cwd: string,
        projectFiles: Set<string>, hallucinated: HallucinatedImport[]
    ): void {
        const lines = content.split('\n');
        const nugetPackages = this.loadNuGetPackages(cwd);

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();

            // Match: using Namespace; and using static Namespace.Class;
            // Skip: using alias = Namespace; and using (var x = ...) disposable
            const usingMatch = line.match(/^using\s+(?:static\s+)?([\w.]+)\s*;/);
            if (!usingMatch) continue;

            const namespace = usingMatch[1];

            // 1. Skip .NET framework and BCL namespaces
            if (this.isDotNetFramework(namespace)) continue;

            // 2. Skip NuGet packages from .csproj
            const topLevel = namespace.split('.')[0];
            if (nugetPackages.has(topLevel) || nugetPackages.has(namespace.split('.').slice(0, 2).join('.'))) continue;

            // 3. Check if the namespace maps to any .cs file in the project
            //    C# namespaces often have a root prefix (project name) not in the directory tree
            //    e.g. MyProject.Services.UserService → check Services/UserService AND MyProject/Services/UserService
            const nsParts = namespace.split('.');
            const nsPath = namespace.replace(/\./g, '/');
            // Also check without root prefix (common convention: namespace root != directory root)
            const nsPathNoRoot = nsParts.slice(1).join('/');

            const csFiles = [...projectFiles].filter(f => f.endsWith('.cs'));
            const hasMatch = csFiles.some(f =>
                f.includes(nsPath) || (nsPathNoRoot && f.includes(nsPathNoRoot))
            );

            // Only flag if we have .csproj context (proves this is a real .NET project)
            if (!hasMatch && namespace.includes('.') && nugetPackages.size >= 0) {
                // Check if we actually have .csproj context (a real .NET project)
                const hasCsproj = this.hasCsprojFile(cwd);
                if (hasCsproj) {
                    hallucinated.push({
                        file, line: i + 1, importPath: namespace, type: 'csharp',
                        reason: `Namespace '${namespace}' — no matching files in project, not in NuGet packages`,
                    });
                }
            }
        }
    }

    /** Check if any .csproj file exists in the project root */
    private hasCsprojFile(cwd: string): boolean {
        try {
            const files = fs.readdirSync?.(cwd) || [];
            return files.some((f: any) => typeof f === 'string' && f.endsWith('.csproj'));
        } catch { return false; }
    }

    /** Parse .csproj files for PackageReference names */
    private loadNuGetPackages(cwd: string): Set<string> {
        const packages = new Set<string>();
        try {
            const files = fs.readdirSync?.(cwd) || [];
            for (const f of files) {
                if (typeof f === 'string' && f.endsWith('.csproj')) {
                    try {
                        const content = fs.readFileSync(path.join(cwd, f), 'utf-8');
                        const pkgPattern = /PackageReference\s+Include="([^"]+)"/g;
                        let m;
                        while ((m = pkgPattern.exec(content)) !== null) {
                            packages.add(m[1]);
                            // Also add top-level namespace (e.g. Newtonsoft.Json → Newtonsoft)
                            packages.add(m[1].split('.')[0]);
                        }
                    } catch { /* skip */ }
                }
            }
        } catch { /* no .csproj */ }
        return packages;
    }

    /**
     * .NET 8 framework and common ecosystem namespaces
     * Covers BCL, ASP.NET, EF Core, and major ecosystem packages
     */
    private isDotNetFramework(namespace: string): boolean {
        const topLevel = namespace.split('.')[0];
        const frameworkPrefixes = new Set([
            // BCL / .NET Runtime
            'System', 'Microsoft', 'Windows',
            // Common ecosystem (NuGet defaults everyone uses)
            'Newtonsoft', 'NUnit', 'Xunit', 'Moq', 'AutoMapper',
            'FluentAssertions', 'FluentValidation', 'Serilog', 'NLog',
            'Dapper', 'MediatR', 'Polly', 'Swashbuckle', 'Hangfire',
            'StackExchange', 'Npgsql', 'MongoDB', 'MySql', 'Oracle',
            'Amazon', 'Google', 'Azure', 'Grpc',
            'Bogus', 'Humanizer', 'CsvHelper', 'MailKit', 'MimeKit',
            'RestSharp', 'Refit', 'AutoFixture', 'Shouldly',
            'IdentityModel', 'IdentityServer4',
        ]);
        return frameworkPrefixes.has(topLevel);
    }

    /**
     * Check Rust imports — use/extern crate against std/core/alloc and Cargo.toml
     *
     * Strategy:
     *  1. Skip Rust std, core, alloc crates
     *  2. Skip crates listed in Cargo.toml [dependencies]
     *  3. Flag unknown extern crate and use statements for project modules that don't exist
     *
     * @since v3.0.1
     */
    private checkRustImports(
        content: string, file: string, cwd: string,
        projectFiles: Set<string>, hallucinated: HallucinatedImport[]
    ): void {
        const lines = content.split('\n');
        const cargoDeps = this.loadCargoDeps(cwd);

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (line.startsWith('//') || line.startsWith('/*')) continue;

            // extern crate foo;
            const externMatch = line.match(/^extern\s+crate\s+(\w+)/);
            if (externMatch) {
                const crateName = externMatch[1];
                if (this.isRustStdCrate(crateName)) continue;
                if (cargoDeps.has(crateName)) continue;
                hallucinated.push({
                    file, line: i + 1, importPath: crateName, type: 'rust',
                    reason: `extern crate '${crateName}' — not in Cargo.toml or Rust std`,
                });
                continue;
            }

            // use foo::bar::baz;  or  use foo::{bar, baz};
            const useMatch = line.match(/^(?:pub\s+)?use\s+(\w+)::/);
            if (useMatch) {
                const crateName = useMatch[1];
                if (this.isRustStdCrate(crateName)) continue;
                if (cargoDeps.has(crateName)) continue;
                // 'crate' and 'self' and 'super' are Rust path keywords
                if (['crate', 'self', 'super'].includes(crateName)) continue;
                hallucinated.push({
                    file, line: i + 1, importPath: crateName, type: 'rust',
                    reason: `use ${crateName}:: — crate not in Cargo.toml or Rust std`,
                });
            }
        }
    }

    /** Load dependency names from Cargo.toml */
    private loadCargoDeps(cwd: string): Set<string> {
        const deps = new Set<string>();
        try {
            const cargoPath = path.join(cwd, 'Cargo.toml');
            if (fs.pathExistsSync(cargoPath)) {
                const content = fs.readFileSync(cargoPath, 'utf-8');
                // Match [dependencies] section entries: name = "version" or name = { ... }
                const depPattern = /^\s*(\w[\w-]*)\s*=/gm;
                let inDeps = false;
                for (const line of content.split('\n')) {
                    if (/^\[(?:.*-)?dependencies/.test(line.trim())) { inDeps = true; continue; }
                    if (/^\[/.test(line.trim()) && inDeps) { inDeps = false; continue; }
                    if (inDeps) {
                        const m = line.match(/^\s*([\w][\w-]*)\s*=/);
                        if (m) deps.add(m[1].replace(/-/g, '_')); // Rust uses _ in code for - in Cargo
                    }
                }
            }
        } catch { /* no Cargo.toml */ }
        return deps;
    }

    /** Rust standard crates — std, core, alloc, proc_macro, and common test crates */
    private isRustStdCrate(name: string): boolean {
        const stdCrates = new Set([
            'std', 'core', 'alloc', 'proc_macro', 'test',
            // Common proc-macro / compiler crates
            'proc_macro2', 'syn', 'quote',
        ]);
        return stdCrates.has(name);
    }

    /**
     * Check Java/Kotlin imports — against stdlib and build dependencies
     *
     * Strategy:
     *  1. Skip java.*, javax.*, jakarta.* (Java stdlib/EE)
     *  2. Skip kotlin.*, kotlinx.* (Kotlin stdlib)
     *  3. Skip deps from build.gradle or pom.xml
     *  4. Flag project-relative imports that don't resolve
     *
     * @since v3.0.1
     */
    private checkJavaKotlinImports(
        content: string, file: string, ext: string, cwd: string,
        projectFiles: Set<string>, hallucinated: HallucinatedImport[]
    ): void {
        const lines = content.split('\n');
        const buildDeps = this.loadJavaDeps(cwd);
        const isKotlin = ext === '.kt';

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();

            // import com.example.package.Class
            const importMatch = line.match(/^import\s+(?:static\s+)?([\w.]+)/);
            if (!importMatch) continue;

            const importPath = importMatch[1];

            // Skip Java stdlib
            if (this.isJavaStdlib(importPath)) continue;

            // Skip Kotlin stdlib
            if (isKotlin && this.isKotlinStdlib(importPath)) continue;

            // Skip known build dependencies (by group prefix)
            const parts = importPath.split('.');
            const group2 = parts.slice(0, 2).join('.');
            const group3 = parts.slice(0, 3).join('.');
            if (buildDeps.has(group2) || buildDeps.has(group3)) continue;

            // Check if it resolves to a project file
            const javaPath = importPath.replace(/\./g, '/');
            const candidates = [
                javaPath + '.java',
                javaPath + '.kt',
                'src/main/java/' + javaPath + '.java',
                'src/main/kotlin/' + javaPath + '.kt',
            ];
            const found = candidates.some(c => projectFiles.has(c)) ||
                [...projectFiles].some(f => f.includes(javaPath));

            if (!found) {
                // Only flag if we have build deps context (Gradle/Maven project)
                if (buildDeps.size > 0) {
                    hallucinated.push({
                        file, line: i + 1, importPath, type: isKotlin ? 'kotlin' : 'java',
                        reason: `import '${importPath}' — not in stdlib, build deps, or project files`,
                    });
                }
            }
        }
    }

    /** Load dependency group IDs from build.gradle or pom.xml */
    private loadJavaDeps(cwd: string): Set<string> {
        const deps = new Set<string>();
        try {
            // Gradle: build.gradle or build.gradle.kts
            for (const gradleFile of ['build.gradle', 'build.gradle.kts']) {
                const gradlePath = path.join(cwd, gradleFile);
                if (fs.pathExistsSync(gradlePath)) {
                    const content = fs.readFileSync(gradlePath, 'utf-8');
                    // Match: implementation 'group:artifact:version' or "group:artifact:version"
                    const depPattern = /(?:implementation|api|compile|testImplementation|runtimeOnly)\s*[('"]([^:'"]+)/g;
                    let m;
                    while ((m = depPattern.exec(content)) !== null) {
                        deps.add(m[1]); // group ID like "com.google.guava"
                    }
                }
            }
            // Maven: pom.xml
            const pomPath = path.join(cwd, 'pom.xml');
            if (fs.pathExistsSync(pomPath)) {
                const content = fs.readFileSync(pomPath, 'utf-8');
                const groupPattern = /<groupId>([^<]+)<\/groupId>/g;
                let m;
                while ((m = groupPattern.exec(content)) !== null) {
                    deps.add(m[1]);
                }
            }
        } catch { /* no build files */ }
        return deps;
    }

    /** Java standard library and Jakarta EE namespaces */
    private isJavaStdlib(importPath: string): boolean {
        const prefixes = [
            'java.', 'javax.', 'jakarta.',
            'sun.', 'com.sun.', 'jdk.',
            // Android SDK
            'android.', 'androidx.',
            // Common ecosystem (so ubiquitous they're basically stdlib)
            'org.junit.', 'org.slf4j.', 'org.apache.logging.',
        ];
        return prefixes.some(p => importPath.startsWith(p));
    }

    /** Kotlin standard library namespaces */
    private isKotlinStdlib(importPath: string): boolean {
        const prefixes = [
            'kotlin.', 'kotlinx.',
            // Java interop (Kotlin can use Java stdlib directly)
            'java.', 'javax.', 'jakarta.',
        ];
        return prefixes.some(p => importPath.startsWith(p));
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
