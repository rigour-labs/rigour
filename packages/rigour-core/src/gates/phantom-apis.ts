/**
 * Phantom APIs Gate
 *
 * Detects calls to non-existent methods/properties on known stdlib modules.
 * AI models confidently generate method names that look correct but don't exist —
 * e.g. fs.readFileAsync(), path.combine(), crypto.generateHash().
 *
 * This is the #2 most dangerous AI hallucination after package hallucination.
 * Unlike type checkers, this gate catches phantom APIs even in plain JS, Python,
 * and other dynamically-typed languages where the call would silently fail at runtime.
 *
 * Supported languages:
 *   JS/TS  — Node.js 22.x builtins (fs, path, crypto, http, os, child_process, etc.)
 *   Python — stdlib modules (os, json, sys, re, datetime, pathlib, subprocess, etc.)
 *   Go     — Common hallucinated stdlib patterns (strings vs bytes, os vs io, etc.)
 *   C#     — Common .NET hallucinated APIs (LINQ, File I/O, string methods)
 *   Java   — Common hallucinated JDK APIs (Collections, String, Stream, Files)
 *
 * @since v3.0.0
 * @since v3.0.3 — Go, C#, Java pattern-based detection added
 */

import { Gate, GateContext } from './base.js';
import { Failure, Provenance } from '../types/index.js';
import { FileScanner } from '../utils/scanner.js';
import { Logger } from '../utils/logger.js';
import fs from 'fs-extra';
import path from 'path';

export interface PhantomApiCall {
    file: string;
    line: number;
    module: string;
    method: string;
    reason: string;
}

export interface PhantomApisConfig {
    enabled?: boolean;
    check_node?: boolean;
    check_python?: boolean;
    check_go?: boolean;
    check_csharp?: boolean;
    check_java?: boolean;
    ignore_patterns?: string[];
}

export class PhantomApisGate extends Gate {
    private config: Required<Omit<PhantomApisConfig, 'ignore_patterns'>> & { ignore_patterns: string[] };

    constructor(config: PhantomApisConfig = {}) {
        super('phantom-apis', 'Phantom API Detection');
        this.config = {
            enabled: config.enabled ?? true,
            check_node: config.check_node ?? true,
            check_python: config.check_python ?? true,
            check_go: config.check_go ?? true,
            check_csharp: config.check_csharp ?? true,
            check_java: config.check_java ?? true,
            ignore_patterns: config.ignore_patterns ?? [],
        };
    }

    protected get provenance(): Provenance { return 'ai-drift'; }

    async run(context: GateContext): Promise<Failure[]> {
        if (!this.config.enabled) return [];

        const failures: Failure[] = [];
        const phantoms: PhantomApiCall[] = [];

        const files = await FileScanner.findFiles({
            cwd: context.cwd,
            patterns: ['**/*.{ts,js,tsx,jsx,py,go,cs,java,kt}'],
            ignore: [...(context.ignore || []), '**/node_modules/**', '**/dist/**', '**/build/**',
                '**/.venv/**', '**/venv/**', '**/vendor/**', '**/__pycache__/**',
                '**/bin/Debug/**', '**/bin/Release/**', '**/obj/**',
                '**/target/**', '**/.gradle/**', '**/out/**'],
        });

        Logger.info(`Phantom APIs: Scanning ${files.length} files`);

        for (const file of files) {
            try {
                const fullPath = path.join(context.cwd, file);
                const content = await fs.readFile(fullPath, 'utf-8');
                const ext = path.extname(file);

                if (['.ts', '.js', '.tsx', '.jsx'].includes(ext) && this.config.check_node) {
                    this.checkNodePhantomApis(content, file, phantoms);
                } else if (ext === '.py' && this.config.check_python) {
                    this.checkPythonPhantomApis(content, file, phantoms);
                } else if (ext === '.go' && this.config.check_go) {
                    this.checkGoPhantomApis(content, file, phantoms);
                } else if (ext === '.cs' && this.config.check_csharp) {
                    this.checkCSharpPhantomApis(content, file, phantoms);
                } else if ((ext === '.java' || ext === '.kt') && this.config.check_java) {
                    this.checkJavaPhantomApis(content, file, phantoms);
                }
            } catch { /* skip unreadable files */ }
        }

        // Group by file
        const byFile = new Map<string, PhantomApiCall[]>();
        for (const p of phantoms) {
            const existing = byFile.get(p.file) || [];
            existing.push(p);
            byFile.set(p.file, existing);
        }

        for (const [file, apis] of byFile) {
            const details = apis.map(a => `  L${a.line}: ${a.module}.${a.method}() — ${a.reason}`).join('\n');
            failures.push(this.createFailure(
                `Phantom API calls in ${file}:\n${details}`,
                [file],
                `These method calls reference functions that don't exist on the target module. AI models confidently hallucinate plausible-sounding method names. Check the official API docs.`,
                'Phantom APIs',
                apis[0].line,
                undefined,
                'high'
            ));
        }

        return failures;
    }

    /**
     * Node.js stdlib method verification.
     * For each known module, we maintain the actual exported methods.
     * Any call like fs.readFileAsync() that doesn't match is flagged.
     */
    private checkNodePhantomApis(content: string, file: string, phantoms: PhantomApiCall[]): void {
        const lines = content.split('\n');

        // Detect which stdlib modules are imported and their local aliases
        const moduleAliases = new Map<string, string>(); // alias → module name
        for (const line of lines) {
            // import fs from 'fs'  /  import * as fs from 'fs'
            const defaultImport = line.match(/import\s+(?:\*\s+as\s+)?(\w+)\s+from\s+['"](?:node:)?(fs|path|crypto|os|child_process|http|https|url|util|stream|events|buffer|querystring|net|dns|tls|zlib|readline|cluster|worker_threads|timers|perf_hooks|assert)['"]/);
            if (defaultImport) {
                moduleAliases.set(defaultImport[1], defaultImport[2]);
                continue;
            }
            // const fs = require('fs')
            const requireImport = line.match(/(?:const|let|var)\s+(\w+)\s*=\s*require\s*\(\s*['"](?:node:)?(fs|path|crypto|os|child_process|http|https|url|util|stream|events|buffer|querystring|net|dns|tls|zlib|readline|cluster|worker_threads|timers|perf_hooks|assert)['"]\s*\)/);
            if (requireImport) {
                moduleAliases.set(requireImport[1], requireImport[2]);
            }
        }

        if (moduleAliases.size === 0) return;

        // Scan for method calls on imported modules
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            for (const [alias, moduleName] of moduleAliases) {
                // Match: alias.methodName( or alias.property.something(
                const callPattern = new RegExp(`\\b${this.escapeRegex(alias)}\\.(\\w+)\\s*\\(`, 'g');
                let match;
                while ((match = callPattern.exec(line)) !== null) {
                    const method = match[1];
                    const knownMethods = NODE_STDLIB_METHODS[moduleName];
                    if (knownMethods && !knownMethods.has(method)) {
                        // Check if it's a common hallucinated method
                        const suggestion = this.suggestNodeMethod(moduleName, method);
                        phantoms.push({
                            file, line: i + 1, module: moduleName, method,
                            reason: `'${method}' does not exist on '${moduleName}'${suggestion ? `. Did you mean '${suggestion}'?` : ''}`,
                        });
                    }
                }
            }
        }
    }

    /**
     * Python stdlib method verification.
     */
    private checkPythonPhantomApis(content: string, file: string, phantoms: PhantomApiCall[]): void {
        const lines = content.split('\n');

        // Detect imported modules: import os / import json as j / from os import path
        const moduleAliases = new Map<string, string>();
        for (const line of lines) {
            const trimmed = line.trim();
            // import os
            const simpleImport = trimmed.match(/^import\s+(os|json|sys|re|math|datetime|pathlib|subprocess|shutil|collections|itertools|functools|typing|io|hashlib|base64|urllib|http|socket|threading|logging|argparse|csv|sqlite3|random|time|copy|glob|tempfile|struct|pickle|gzip|zipfile)\s*$/);
            if (simpleImport) {
                moduleAliases.set(simpleImport[1], simpleImport[1]);
                continue;
            }
            // import os as operating_system
            const aliasImport = trimmed.match(/^import\s+(os|json|sys|re|math|datetime|pathlib|subprocess|shutil|collections|itertools|functools|typing|io|hashlib|base64|urllib|http|socket|threading|logging|argparse|csv|sqlite3|random|time|copy|glob|tempfile|struct|pickle|gzip|zipfile)\s+as\s+(\w+)/);
            if (aliasImport) {
                moduleAliases.set(aliasImport[2], aliasImport[1]);
            }
        }

        if (moduleAliases.size === 0) return;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            for (const [alias, moduleName] of moduleAliases) {
                const callPattern = new RegExp(`\\b${this.escapeRegex(alias)}\\.(\\w+)\\s*\\(`, 'g');
                let match;
                while ((match = callPattern.exec(line)) !== null) {
                    const method = match[1];
                    const knownMethods = PYTHON_STDLIB_METHODS[moduleName];
                    if (knownMethods && !knownMethods.has(method)) {
                        const suggestion = this.suggestPythonMethod(moduleName, method);
                        phantoms.push({
                            file, line: i + 1, module: moduleName, method,
                            reason: `'${method}' does not exist on '${moduleName}'${suggestion ? `. Did you mean '${suggestion}'?` : ''}`,
                        });
                    }
                }
            }
        }
    }

    /** Suggest the closest real method name (Levenshtein distance ≤ 3) */
    private suggestNodeMethod(module: string, phantom: string): string | null {
        const methods = NODE_STDLIB_METHODS[module];
        if (!methods) return null;
        return this.findClosest(phantom, [...methods]);
    }

    private suggestPythonMethod(module: string, phantom: string): string | null {
        const methods = PYTHON_STDLIB_METHODS[module];
        if (!methods) return null;
        return this.findClosest(phantom, [...methods]);
    }

    private findClosest(target: string, candidates: string[]): string | null {
        let best: string | null = null;
        let bestDist = 4; // max distance threshold
        for (const c of candidates) {
            const dist = this.levenshtein(target.toLowerCase(), c.toLowerCase());
            if (dist < bestDist) {
                bestDist = dist;
                best = c;
            }
        }
        return best;
    }

    private levenshtein(a: string, b: string): number {
        const m = a.length, n = b.length;
        const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
        for (let i = 0; i <= m; i++) dp[i][0] = i;
        for (let j = 0; j <= n; j++) dp[0][j] = j;
        for (let i = 1; i <= m; i++) {
            for (let j = 1; j <= n; j++) {
                dp[i][j] = a[i - 1] === b[j - 1]
                    ? dp[i - 1][j - 1]
                    : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
            }
        }
        return dp[m][n];
    }

    /**
     * Go phantom API detection — pattern-based.
     * AI commonly hallucinates Python/JS-style method names on Go packages.
     * e.g. strings.Contains() exists, but strings.includes() doesn't.
     */
    private checkGoPhantomApis(content: string, file: string, phantoms: PhantomApiCall[]): void {
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            for (const rule of GO_PHANTOM_RULES) {
                if (rule.pattern.test(line)) {
                    phantoms.push({
                        file, line: i + 1,
                        module: rule.module, method: rule.phantom,
                        reason: `'${rule.phantom}' does not exist on '${rule.module}'. ${rule.suggestion}`,
                    });
                }
            }
        }
    }

    /**
     * C# phantom API detection — pattern-based.
     * AI hallucinates Java/Python-style method names on .NET types.
     */
    private checkCSharpPhantomApis(content: string, file: string, phantoms: PhantomApiCall[]): void {
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            for (const rule of CSHARP_PHANTOM_RULES) {
                if (rule.pattern.test(line)) {
                    phantoms.push({
                        file, line: i + 1,
                        module: rule.module, method: rule.phantom,
                        reason: `'${rule.phantom}' does not exist in C#. ${rule.suggestion}`,
                    });
                }
            }
        }
    }

    /**
     * Java/Kotlin phantom API detection — pattern-based.
     * AI hallucinates Python/JS-style APIs on JDK classes.
     */
    private checkJavaPhantomApis(content: string, file: string, phantoms: PhantomApiCall[]): void {
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            for (const rule of JAVA_PHANTOM_RULES) {
                if (rule.pattern.test(line)) {
                    phantoms.push({
                        file, line: i + 1,
                        module: rule.module, method: rule.phantom,
                        reason: `'${rule.phantom}' does not exist in Java. ${rule.suggestion}`,
                    });
                }
            }
        }
    }

    private escapeRegex(s: string): string {
        return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
}

interface PhantomRule {
    pattern: RegExp;
    module: string;
    phantom: string;
    suggestion: string;
}

/**
 * Go commonly hallucinated APIs — AI mixes up Python/JS idioms with Go.
 */
const GO_PHANTOM_RULES: PhantomRule[] = [
    { pattern: /\bstrings\.includes\s*\(/, module: 'strings', phantom: 'includes', suggestion: "Use strings.Contains()" },
    { pattern: /\bstrings\.lower\s*\(/, module: 'strings', phantom: 'lower', suggestion: "Use strings.ToLower()" },
    { pattern: /\bstrings\.upper\s*\(/, module: 'strings', phantom: 'upper', suggestion: "Use strings.ToUpper()" },
    { pattern: /\bstrings\.strip\s*\(/, module: 'strings', phantom: 'strip', suggestion: "Use strings.TrimSpace()" },
    { pattern: /\bstrings\.find\s*\(/, module: 'strings', phantom: 'find', suggestion: "Use strings.Index()" },
    { pattern: /\bstrings\.startswith\s*\(/, module: 'strings', phantom: 'startswith', suggestion: "Use strings.HasPrefix()" },
    { pattern: /\bstrings\.endswith\s*\(/, module: 'strings', phantom: 'endswith', suggestion: "Use strings.HasSuffix()" },
    { pattern: /\bos\.ReadFile\s*\(/, module: 'os', phantom: 'ReadFile', suggestion: "Use os.ReadFile() (Go 1.16+) or ioutil.ReadFile() (legacy)" },
    { pattern: /\bos\.Exists\s*\(/, module: 'os', phantom: 'Exists', suggestion: "Use os.Stat() and check os.IsNotExist(err)" },
    { pattern: /\bos\.isdir\s*\(/, module: 'os', phantom: 'isdir', suggestion: "Use os.Stat() then .IsDir()" },
    { pattern: /\bos\.listdir\s*\(/, module: 'os', phantom: 'listdir', suggestion: "Use os.ReadDir()" },
    { pattern: /\bfmt\.Format\s*\(/, module: 'fmt', phantom: 'Format', suggestion: "Use fmt.Sprintf()" },
    { pattern: /\bfmt\.Print\s*\((?!ln|f)/, module: 'fmt', phantom: 'Print', suggestion: "fmt.Print() exists but did you mean fmt.Println() or fmt.Printf()?" },
    { pattern: /\bhttp\.Get\s*\([^)]*\)\s*\.\s*Body/, module: 'http', phantom: 'Get().Body', suggestion: "http.Get() returns (*Response, error) — must check error first" },
    { pattern: /\bjson\.parse\s*\(/, module: 'json', phantom: 'parse', suggestion: "Use json.Unmarshal()" },
    { pattern: /\bjson\.stringify\s*\(/, module: 'json', phantom: 'stringify', suggestion: "Use json.Marshal()" },
    { pattern: /\bfilepath\.Combine\s*\(/, module: 'filepath', phantom: 'Combine', suggestion: "Use filepath.Join()" },
    { pattern: /\bmath\.Max\s*\(/, module: 'math', phantom: 'Max (pre-1.21)', suggestion: "math.Max() only works on float64. For int, use max() builtin (Go 1.21+)" },
    { pattern: /\bsort\.Sort\s*\(\s*\[\]/, module: 'sort', phantom: 'Sort([]T)', suggestion: "Use slices.Sort() (Go 1.21+) or sort.Slice()" },
];

/**
 * C# commonly hallucinated APIs — AI mixes up Java/Python idioms with .NET.
 */
const CSHARP_PHANTOM_RULES: PhantomRule[] = [
    { pattern: /\.length\b(?!\s*\()/, module: 'String', phantom: '.length', suggestion: "Use .Length (capital L) in C#" },
    { pattern: /\.equals\s*\(/, module: 'Object', phantom: '.equals()', suggestion: "Use .Equals() (capital E) in C#" },
    { pattern: /\.toString\s*\(/, module: 'Object', phantom: '.toString()', suggestion: "Use .ToString() (capital T) in C#" },
    { pattern: /\.hashCode\s*\(/, module: 'Object', phantom: '.hashCode()', suggestion: "Use .GetHashCode() in C#" },
    { pattern: /\.getClass\s*\(/, module: 'Object', phantom: '.getClass()', suggestion: "Use .GetType() in C#" },
    { pattern: /\.isEmpty\s*\(/, module: 'String', phantom: '.isEmpty()', suggestion: "Use string.IsNullOrEmpty() or .Length == 0 in C#" },
    { pattern: /\.charAt\s*\(/, module: 'String', phantom: '.charAt()', suggestion: "Use string[index] indexer in C#" },
    { pattern: /\.substring\s*\(/, module: 'String', phantom: '.substring()', suggestion: "Use .Substring() (capital S) in C#" },
    { pattern: /\.indexOf\s*\(/, module: 'String', phantom: '.indexOf()', suggestion: "Use .IndexOf() (capital I) in C#" },
    { pattern: /List<[^>]+>\s+\w+\s*=\s*new\s+ArrayList/, module: 'Collections', phantom: 'ArrayList', suggestion: "Use new List<T>() in C# — ArrayList is Java" },
    { pattern: /HashMap</, module: 'Collections', phantom: 'HashMap', suggestion: "Use Dictionary<TKey, TValue> in C#" },
    { pattern: /System\.out\.println/, module: 'System', phantom: 'System.out.println', suggestion: "Use Console.WriteLine() in C#" },
    { pattern: /\.stream\s*\(\)\s*\./, module: 'Collections', phantom: '.stream()', suggestion: "Use LINQ (.Select, .Where, etc.) in C# — .stream() is Java" },
    { pattern: /\.forEach\s*\(\s*\w+\s*->/, module: 'Collections', phantom: '.forEach(x ->)', suggestion: "Use .ForEach(x =>) or foreach loop in C#" },
    { pattern: /File\.readAllText\s*\(/, module: 'File', phantom: 'readAllText', suggestion: "Use File.ReadAllText() (capital R) in C#" },
    { pattern: /throws\s+\w+Exception/, module: 'method', phantom: 'throws', suggestion: "C# doesn't use checked exceptions — remove throws clause" },
];

/**
 * Java commonly hallucinated APIs — AI mixes up Python/JS/C# idioms with JDK.
 */
const JAVA_PHANTOM_RULES: PhantomRule[] = [
    { pattern: /\.len\s*\(/, module: 'Object', phantom: '.len()', suggestion: "Use .length() for String, .size() for Collection, .length for arrays in Java" },
    { pattern: /\bprint\s*\(\s*['"]/, module: 'IO', phantom: 'print()', suggestion: "Use System.out.println() in Java" },
    { pattern: /\.push\s*\(/, module: 'List', phantom: '.push()', suggestion: "Use .add() for List in Java" },
    { pattern: /\.append\s*\((?!.*StringBuilder|.*StringBuffer)/, module: 'List', phantom: '.append()', suggestion: "Use .add() for List in Java — .append() is for StringBuilder" },
    { pattern: /\.include(?:s)?\s*\(/, module: 'Collection', phantom: '.includes()', suggestion: "Use .contains() in Java" },
    { pattern: /\.slice\s*\(/, module: 'List', phantom: '.slice()', suggestion: "Use .subList() for List in Java" },
    { pattern: /\.map\s*\(\s*\w+\s*=>/, module: 'Collection', phantom: '.map(x =>)', suggestion: "Use .stream().map(x ->) in Java — arrow is -> not =>" },
    { pattern: /\.filter\s*\(\s*\w+\s*=>/, module: 'Collection', phantom: '.filter(x =>)', suggestion: "Use .stream().filter(x ->) in Java — arrow is -> not =>" },
    { pattern: /Console\.(?:Write|Read)/, module: 'IO', phantom: 'Console', suggestion: "Console is C# — use System.out.println() or Scanner in Java" },
    { pattern: /\bvar\s+\w+\s*:\s*\w+\s*=/, module: 'syntax', phantom: 'var x: Type =', suggestion: "Java var doesn't use type annotation: use 'var x =' or 'Type x ='" },
    { pattern: /\.sorted\s*\(\s*\)(?!\s*\.)/, module: 'List', phantom: '.sorted()', suggestion: "Use Collections.sort() or .stream().sorted() in Java" },
    { pattern: /\.reversed\s*\(/, module: 'List', phantom: '.reversed()', suggestion: "Use Collections.reverse() in Java (pre-21) or .reversed() (Java 21+)" },
    { pattern: /String\.format\s*\(\s*\$"/, module: 'String', phantom: 'String.format($"...")', suggestion: "String interpolation $\"\" is C# — use String.format(\"%s\", ...) in Java" },
    { pattern: /\bnew\s+Map\s*[<(]/, module: 'Collections', phantom: 'new Map()', suggestion: "Use new HashMap<>() in Java — Map is an interface" },
    { pattern: /\bnew\s+List\s*[<(]/, module: 'Collections', phantom: 'new List()', suggestion: "Use new ArrayList<>() in Java — List is an interface" },
];

/**
 * Node.js 22.x stdlib method signatures.
 * Only the most commonly hallucinated modules are covered.
 * Each set contains ALL public methods/properties accessible on the module.
 */
const NODE_STDLIB_METHODS: Record<string, Set<string>> = {
    fs: new Set([
        // Sync methods
        'readFileSync', 'writeFileSync', 'appendFileSync', 'copyFileSync', 'renameSync',
        'unlinkSync', 'mkdirSync', 'rmdirSync', 'rmSync', 'readdirSync', 'statSync',
        'lstatSync', 'existsSync', 'accessSync', 'chmodSync', 'chownSync', 'closeSync',
        'fchmodSync', 'fchownSync', 'fdatasyncSync', 'fstatSync', 'fsyncSync',
        'ftruncateSync', 'futimesSync', 'linkSync', 'lutimesSync', 'mkdtempSync',
        'openSync', 'opendirSync', 'readSync', 'readlinkSync', 'realpathSync',
        'symlinkSync', 'truncateSync', 'utimesSync', 'writeSync', 'cpSync',
        'statfsSync', 'globSync',
        // Async callback methods
        'readFile', 'writeFile', 'appendFile', 'copyFile', 'rename', 'unlink',
        'mkdir', 'rmdir', 'rm', 'readdir', 'stat', 'lstat', 'access', 'chmod',
        'chown', 'close', 'fchmod', 'fchown', 'fdatasync', 'fstat', 'fsync',
        'ftruncate', 'futimes', 'link', 'lutimes', 'mkdtemp', 'open', 'opendir',
        'read', 'readlink', 'realpath', 'symlink', 'truncate', 'utimes', 'write',
        'cp', 'statfs', 'glob',
        // Streams
        'createReadStream', 'createWriteStream',
        // Watch
        'watch', 'watchFile', 'unwatchFile',
        // Constants & promises
        'constants', 'promises',
    ]),
    path: new Set([
        'basename', 'delimiter', 'dirname', 'extname', 'format', 'isAbsolute',
        'join', 'normalize', 'parse', 'posix', 'relative', 'resolve', 'sep',
        'toNamespacedPath', 'win32', 'matchesGlob',
    ]),
    crypto: new Set([
        'createHash', 'createHmac', 'createCipheriv', 'createDecipheriv',
        'createSign', 'createVerify', 'createDiffieHellman', 'createDiffieHellmanGroup',
        'createECDH', 'createSecretKey', 'createPublicKey', 'createPrivateKey',
        'generateKey', 'generateKeyPair', 'generateKeyPairSync', 'generateKeySync',
        'generatePrime', 'generatePrimeSync',
        'getCiphers', 'getCurves', 'getDiffieHellman', 'getFips', 'getHashes',
        'getRandomValues', 'hash',
        'hkdf', 'hkdfSync',
        'pbkdf2', 'pbkdf2Sync',
        'privateDecrypt', 'privateEncrypt', 'publicDecrypt', 'publicEncrypt',
        'randomBytes', 'randomFillSync', 'randomFill', 'randomInt', 'randomUUID',
        'scrypt', 'scryptSync',
        'setEngine', 'setFips',
        'sign', 'verify',
        'subtle', 'timingSafeEqual',
        'constants', 'webcrypto', 'X509Certificate',
        'checkPrime', 'checkPrimeSync',
        'Certificate', 'Cipher', 'Decipher', 'DiffieHellman', 'DiffieHellmanGroup',
        'ECDH', 'Hash', 'Hmac', 'KeyObject', 'Sign', 'Verify',
    ]),
    os: new Set([
        'arch', 'availableParallelism', 'constants', 'cpus', 'devNull',
        'endianness', 'EOL', 'freemem', 'getPriority', 'homedir',
        'hostname', 'loadavg', 'machine', 'networkInterfaces', 'platform',
        'release', 'setPriority', 'tmpdir', 'totalmem', 'type',
        'uptime', 'userInfo', 'version',
    ]),
    child_process: new Set([
        'exec', 'execFile', 'execFileSync', 'execSync',
        'fork', 'spawn', 'spawnSync',
    ]),
    http: new Set([
        'createServer', 'get', 'globalAgent', 'request',
        'Agent', 'ClientRequest', 'Server', 'ServerResponse', 'IncomingMessage',
        'METHODS', 'STATUS_CODES', 'maxHeaderSize', 'validateHeaderName', 'validateHeaderValue',
        'setMaxIdleHTTPParsers',
    ]),
    https: new Set([
        'createServer', 'get', 'globalAgent', 'request',
        'Agent', 'Server',
    ]),
    url: new Set([
        'domainToASCII', 'domainToUnicode', 'fileURLToPath', 'format',
        'pathToFileURL', 'resolve', 'URL', 'URLSearchParams',
        // Deprecated but still exist
        'parse', 'Url',
    ]),
    util: new Set([
        'callbackify', 'debuglog', 'deprecate', 'format', 'formatWithOptions',
        'getSystemErrorName', 'getSystemErrorMap', 'inherits', 'inspect',
        'isDeepStrictEqual', 'parseArgs', 'parseEnv', 'promisify',
        'stripVTControlCharacters', 'styleText',
        'TextDecoder', 'TextEncoder', 'MIMEType', 'MIMEParams',
        'types', 'toUSVString', 'transferableAbortController', 'transferableAbortSignal',
        'aborted',
    ]),
    stream: new Set([
        'Readable', 'Writable', 'Duplex', 'Transform', 'PassThrough',
        'pipeline', 'finished', 'compose', 'addAbortSignal',
        'getDefaultHighWaterMark', 'setDefaultHighWaterMark',
        'promises', 'consumers',
    ]),
    events: new Set([
        'EventEmitter', 'once', 'on', 'getEventListeners',
        'setMaxListeners', 'listenerCount', 'addAbortListener',
        'getMaxListeners', 'EventEmitterAsyncResource',
    ]),
    buffer: new Set([
        'Buffer', 'SlowBuffer', 'transcode',
        'constants', 'kMaxLength', 'kStringMaxLength',
        'atob', 'btoa', 'isAscii', 'isUtf8', 'resolveObjectURL',
        'Blob', 'File',
    ]),
    querystring: new Set([
        'decode', 'encode', 'escape', 'parse', 'stringify', 'unescape',
    ]),
    net: new Set([
        'createServer', 'createConnection', 'connect',
        'isIP', 'isIPv4', 'isIPv6',
        'Server', 'Socket', 'BlockList', 'SocketAddress',
        'getDefaultAutoSelectFamily', 'setDefaultAutoSelectFamily',
        'getDefaultAutoSelectFamilyAttemptTimeout', 'setDefaultAutoSelectFamilyAttemptTimeout',
    ]),
    dns: new Set([
        'lookup', 'lookupService', 'resolve', 'resolve4', 'resolve6',
        'resolveAny', 'resolveCname', 'resolveCaa', 'resolveMx', 'resolveNaptr',
        'resolveNs', 'resolvePtr', 'resolveSoa', 'resolveSrv', 'resolveTxt',
        'reverse', 'setServers', 'getServers', 'setDefaultResultOrder',
        'getDefaultResultOrder',
        'promises', 'Resolver', 'ADDRCONFIG', 'V4MAPPED', 'ALL',
    ]),
    tls: new Set([
        'createServer', 'connect', 'createSecureContext', 'createSecurePair',
        'getCiphers', 'rootCertificates', 'DEFAULT_ECDH_CURVE', 'DEFAULT_MAX_VERSION',
        'DEFAULT_MIN_VERSION', 'DEFAULT_CIPHERS',
        'Server', 'TLSSocket', 'SecureContext',
    ]),
    zlib: new Set([
        'createGzip', 'createGunzip', 'createDeflate', 'createInflate',
        'createDeflateRaw', 'createInflateRaw', 'createBrotliCompress',
        'createBrotliDecompress', 'createUnzip',
        'gzip', 'gunzip', 'deflate', 'inflate', 'deflateRaw', 'inflateRaw',
        'brotliCompress', 'brotliDecompress', 'unzip',
        'gzipSync', 'gunzipSync', 'deflateSync', 'inflateSync',
        'deflateRawSync', 'inflateRawSync', 'brotliCompressSync',
        'brotliDecompressSync', 'unzipSync',
        'constants',
    ]),
    readline: new Set([
        'createInterface', 'clearLine', 'clearScreenDown', 'cursorTo',
        'moveCursor', 'emitKeypressEvents',
        'Interface', 'InterfaceConstructor', 'promises',
    ]),
    cluster: new Set([
        'disconnect', 'fork', 'isMaster', 'isPrimary', 'isWorker',
        'schedulingPolicy', 'settings', 'setupMaster', 'setupPrimary',
        'worker', 'workers',
        'Worker', 'SCHED_NONE', 'SCHED_RR',
    ]),
    worker_threads: new Set([
        'isMainThread', 'parentPort', 'resourceLimits', 'threadId',
        'workerData', 'getEnvironmentData', 'setEnvironmentData',
        'markAsUntransferable', 'moveMessagePortToContext', 'receiveMessageOnPort',
        'BroadcastChannel', 'MessageChannel', 'MessagePort', 'Worker',
        'SHARE_ENV',
    ]),
    timers: new Set([
        'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
        'setImmediate', 'clearImmediate',
        'promises',
    ]),
    perf_hooks: new Set([
        'performance', 'PerformanceObserver', 'PerformanceEntry',
        'PerformanceMark', 'PerformanceMeasure', 'PerformanceNodeTiming',
        'PerformanceResourceTiming', 'monitorEventLoopDelay',
        'createHistogram',
    ]),
    assert: new Set([
        'ok', 'fail', 'equal', 'notEqual', 'deepEqual', 'notDeepEqual',
        'deepStrictEqual', 'notDeepStrictEqual', 'strictEqual', 'notStrictEqual',
        'throws', 'doesNotThrow', 'rejects', 'doesNotReject',
        'ifError', 'match', 'doesNotMatch',
        'strict', 'AssertionError', 'CallTracker',
    ]),
};

/**
 * Python 3.12+ stdlib method signatures.
 * Covers the most commonly hallucinated modules.
 */
const PYTHON_STDLIB_METHODS: Record<string, Set<string>> = {
    os: new Set([
        'getcwd', 'chdir', 'listdir', 'scandir', 'mkdir', 'makedirs',
        'rmdir', 'removedirs', 'remove', 'unlink', 'rename', 'renames',
        'replace', 'stat', 'lstat', 'fstat', 'chmod', 'chown', 'link',
        'symlink', 'readlink', 'walk', 'fwalk', 'path', 'environ',
        'getenv', 'putenv', 'unsetenv', 'getpid', 'getppid', 'getuid',
        'getgid', 'system', 'popen', 'execv', 'execve', 'execvp',
        'execvpe', '_exit', 'fork', 'kill', 'wait', 'waitpid',
        'cpu_count', 'urandom', 'sep', 'linesep', 'devnull', 'curdir',
        'pardir', 'extsep', 'altsep', 'pathsep', 'name', 'access',
        'open', 'close', 'read', 'write', 'pipe', 'dup', 'dup2',
        'ftruncate', 'isatty', 'lseek', 'terminal_size', 'get_terminal_size',
        'get_blocking', 'set_blocking', 'add_dll_directory',
        'get_exec_path', 'getlogin', 'strerror', 'umask',
        'truncate', 'fchdir', 'fchmod', 'fchown',
    ]),
    json: new Set([
        'dump', 'dumps', 'load', 'loads',
        'JSONDecoder', 'JSONEncoder', 'JSONDecodeError',
        'tool',
    ]),
    sys: new Set([
        'argv', 'exit', 'path', 'modules', 'stdin', 'stdout', 'stderr',
        'version', 'version_info', 'platform', 'executable', 'prefix',
        'exec_prefix', 'maxsize', 'maxunicode', 'byteorder', 'builtin_module_names',
        'flags', 'float_info', 'hash_info', 'implementation', 'int_info',
        'getdefaultencoding', 'getfilesystemencoding', 'getrecursionlimit',
        'getrefcount', 'getsizeof', 'gettrace', 'getprofile',
        'setrecursionlimit', 'settrace', 'setprofile',
        'exc_info', 'last_type', 'last_value', 'last_traceback',
        'api_version', 'copyright', 'dont_write_bytecode',
        'ps1', 'ps2', 'intern', 'is_finalizing',
        'orig_argv', 'platlibdir', 'stdlib_module_names',
        'thread_info', 'unraisablehook', 'winver',
        'addaudithook', 'audit', 'breakpointhook',
        'call_tracing', 'displayhook', 'excepthook',
        'get_asyncgen_hooks', 'get_coroutine_origin_tracking_depth',
        'getallocatedblocks', 'getwindowsversion',
        'set_asyncgen_hooks', 'set_coroutine_origin_tracking_depth',
        'set_int_max_str_digits', 'get_int_max_str_digits',
        'activate_stack_trampoline', 'deactivate_stack_trampoline',
        'is_stack_trampoline_active', 'last_exc',
        'monitoring', 'exception',
    ]),
    re: new Set([
        'compile', 'search', 'match', 'fullmatch', 'split', 'findall',
        'finditer', 'sub', 'subn', 'escape', 'purge', 'error',
        'Pattern', 'Match',
        'A', 'ASCII', 'DEBUG', 'DOTALL', 'I', 'IGNORECASE',
        'L', 'LOCALE', 'M', 'MULTILINE', 'NOFLAG',
        'S', 'U', 'UNICODE', 'VERBOSE', 'X',
    ]),
    math: new Set([
        'ceil', 'comb', 'copysign', 'fabs', 'factorial', 'floor',
        'fmod', 'frexp', 'fsum', 'gcd', 'isclose', 'isfinite',
        'isinf', 'isnan', 'isqrt', 'lcm', 'ldexp', 'log', 'log10',
        'log1p', 'log2', 'modf', 'perm', 'pow', 'prod', 'remainder',
        'trunc', 'ulp', 'nextafter', 'sumprod',
        'exp', 'exp2', 'expm1', 'sqrt', 'cbrt',
        'acos', 'acosh', 'asin', 'asinh', 'atan', 'atan2', 'atanh',
        'cos', 'cosh', 'degrees', 'dist', 'hypot', 'radians',
        'sin', 'sinh', 'tan', 'tanh',
        'erf', 'erfc', 'gamma', 'lgamma',
        'pi', 'e', 'tau', 'inf', 'nan',
    ]),
    datetime: new Set([
        'date', 'time', 'datetime', 'timedelta', 'timezone', 'tzinfo',
        'MINYEAR', 'MAXYEAR', 'UTC',
    ]),
    pathlib: new Set([
        'Path', 'PurePath', 'PurePosixPath', 'PureWindowsPath',
        'PosixPath', 'WindowsPath',
    ]),
    subprocess: new Set([
        'run', 'call', 'check_call', 'check_output', 'Popen',
        'PIPE', 'STDOUT', 'DEVNULL', 'CompletedProcess',
        'CalledProcessError', 'SubprocessError', 'TimeoutExpired',
        'getoutput', 'getstatusoutput',
    ]),
    shutil: new Set([
        'copy', 'copy2', 'copyfile', 'copyfileobj', 'copymode', 'copystat',
        'copytree', 'rmtree', 'move', 'disk_usage', 'chown', 'which',
        'make_archive', 'get_archive_formats', 'register_archive_format',
        'unregister_archive_format', 'unpack_archive', 'get_unpack_formats',
        'register_unpack_format', 'unregister_unpack_format',
        'get_terminal_size', 'SameFileError',
    ]),
    collections: new Set([
        'ChainMap', 'Counter', 'OrderedDict', 'UserDict', 'UserList',
        'UserString', 'abc', 'defaultdict', 'deque', 'namedtuple',
    ]),
    hashlib: new Set([
        'md5', 'sha1', 'sha224', 'sha256', 'sha384', 'sha512',
        'sha3_224', 'sha3_256', 'sha3_384', 'sha3_512',
        'blake2b', 'blake2s', 'shake_128', 'shake_256',
        'new', 'algorithms_available', 'algorithms_guaranteed',
        'pbkdf2_hmac', 'scrypt', 'file_digest',
    ]),
    random: new Set([
        'seed', 'getstate', 'setstate', 'getrandbits',
        'randrange', 'randint', 'choice', 'choices', 'shuffle', 'sample',
        'random', 'uniform', 'triangular', 'betavariate', 'expovariate',
        'gammavariate', 'gauss', 'lognormvariate', 'normalvariate',
        'vonmisesvariate', 'paretovariate', 'weibullvariate',
        'Random', 'SystemRandom', 'randbytes',
    ]),
    time: new Set([
        'time', 'time_ns', 'clock_gettime', 'clock_gettime_ns',
        'clock_settime', 'clock_settime_ns', 'clock_getres',
        'gmtime', 'localtime', 'mktime', 'asctime', 'ctime',
        'strftime', 'strptime', 'sleep', 'monotonic', 'monotonic_ns',
        'perf_counter', 'perf_counter_ns', 'process_time', 'process_time_ns',
        'thread_time', 'thread_time_ns', 'get_clock_info',
        'struct_time', 'timezone', 'altzone', 'daylight', 'tzname',
        'CLOCK_BOOTTIME', 'CLOCK_MONOTONIC', 'CLOCK_MONOTONIC_RAW',
        'CLOCK_PROCESS_CPUTIME_ID', 'CLOCK_REALTIME',
        'CLOCK_TAI', 'CLOCK_THREAD_CPUTIME_ID',
    ]),
    csv: new Set([
        'reader', 'writer', 'DictReader', 'DictWriter',
        'Sniffer', 'register_dialect', 'unregister_dialect',
        'get_dialect', 'list_dialects', 'field_size_limit',
        'QUOTE_ALL', 'QUOTE_MINIMAL', 'QUOTE_NONNUMERIC', 'QUOTE_NONE',
        'QUOTE_NOTNULL', 'QUOTE_STRINGS',
        'Dialect', 'Error', 'excel', 'excel_tab', 'unix_dialect',
    ]),
    logging: new Set([
        'getLogger', 'basicConfig', 'shutdown', 'setLoggerClass',
        'setLogRecordFactory', 'lastResort', 'captureWarnings',
        'debug', 'info', 'warning', 'error', 'critical', 'exception',
        'log', 'disable', 'addLevelName', 'getLevelName', 'getLevelNamesMapping',
        'makeLogRecord', 'getHandlerByName', 'getHandlerNames',
        'Logger', 'Handler', 'Formatter', 'Filter', 'LogRecord',
        'StreamHandler', 'FileHandler', 'NullHandler',
        'BufferingFormatter', 'LoggerAdapter', 'PercentStyle',
        'StrFormatStyle', 'StringTemplateStyle',
        'DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL',
        'FATAL', 'WARN', 'NOTSET',
        'raiseExceptions', 'root',
        'handlers', 'config',
    ]),
};
