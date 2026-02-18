/**
 * Deprecated APIs Gate
 *
 * Detects usage of deprecated, removed, or insecure stdlib/framework APIs.
 * AI models are trained on historical code and frequently suggest deprecated patterns
 * that introduce security vulnerabilities, performance issues, or will break on upgrade.
 *
 * Categories:
 *   1. Security-deprecated: APIs removed for security reasons (e.g. new Buffer(), md5 for passwords)
 *   2. Removed APIs: Methods that no longer exist in current versions
 *   3. Superseded APIs: Working but replaced by better alternatives
 *
 * Supported languages:
 *   JS/TS  — Node.js 22.x deprecations, Web API deprecations
 *   Python — Python 3.12+ deprecations and removals
 *   Go     — Deprecated stdlib patterns (ioutil, etc.)
 *   C#     — Deprecated .NET APIs (WebClient, BinaryFormatter, etc.)
 *   Java   — Deprecated JDK APIs (Date, Vector, Hashtable, etc.)
 *
 * @since v3.0.0
 * @since v3.0.3 — Go, C#, Java deprecated API detection added
 */

import { Gate, GateContext } from './base.js';
import { Failure, Provenance } from '../types/index.js';
import { FileScanner } from '../utils/scanner.js';
import { Logger } from '../utils/logger.js';
import fs from 'fs-extra';
import path from 'path';

export interface DeprecatedApiUsage {
    file: string;
    line: number;
    api: string;
    reason: string;
    replacement: string;
    category: 'security' | 'removed' | 'superseded';
}

export interface DeprecatedApisConfig {
    enabled?: boolean;
    check_node?: boolean;
    check_python?: boolean;
    check_web?: boolean;
    check_go?: boolean;
    check_csharp?: boolean;
    check_java?: boolean;
    block_security_deprecated?: boolean;  // Treat security-deprecated as critical
    ignore_patterns?: string[];
}

export class DeprecatedApisGate extends Gate {
    private config: Required<Omit<DeprecatedApisConfig, 'ignore_patterns'>> & { ignore_patterns: string[] };

    constructor(config: DeprecatedApisConfig = {}) {
        super('deprecated-apis', 'Deprecated API Detection');
        this.config = {
            enabled: config.enabled ?? true,
            check_node: config.check_node ?? true,
            check_python: config.check_python ?? true,
            check_web: config.check_web ?? true,
            check_go: config.check_go ?? true,
            check_csharp: config.check_csharp ?? true,
            check_java: config.check_java ?? true,
            block_security_deprecated: config.block_security_deprecated ?? true,
            ignore_patterns: config.ignore_patterns ?? [],
        };
    }

    protected get provenance(): Provenance { return 'ai-drift'; }

    async run(context: GateContext): Promise<Failure[]> {
        if (!this.config.enabled) return [];

        const failures: Failure[] = [];
        const deprecated: DeprecatedApiUsage[] = [];

        const files = await FileScanner.findFiles({
            cwd: context.cwd,
            patterns: ['**/*.{ts,js,tsx,jsx,py,go,cs,java,kt}'],
            ignore: [...(context.ignore || []), '**/node_modules/**', '**/dist/**', '**/build/**',
                '**/.venv/**', '**/venv/**', '**/vendor/**', '**/__pycache__/**',
                '**/bin/Debug/**', '**/bin/Release/**', '**/obj/**',
                '**/target/**', '**/.gradle/**', '**/out/**'],
        });

        Logger.info(`Deprecated APIs: Scanning ${files.length} files`);

        for (const file of files) {
            try {
                const fullPath = path.join(context.cwd, file);
                const content = await fs.readFile(fullPath, 'utf-8');
                const ext = path.extname(file);

                if (['.ts', '.js', '.tsx', '.jsx'].includes(ext)) {
                    if (this.config.check_node) this.checkNodeDeprecated(content, file, deprecated);
                    if (this.config.check_web) this.checkWebDeprecated(content, file, deprecated);
                } else if (ext === '.py' && this.config.check_python) {
                    this.checkPythonDeprecated(content, file, deprecated);
                } else if (ext === '.go' && this.config.check_go) {
                    this.checkGoDeprecated(content, file, deprecated);
                } else if (ext === '.cs' && this.config.check_csharp) {
                    this.checkCSharpDeprecated(content, file, deprecated);
                } else if ((ext === '.java' || ext === '.kt') && this.config.check_java) {
                    this.checkJavaDeprecated(content, file, deprecated);
                }
            } catch { /* skip */ }
        }

        // Group by file and severity
        const byFile = new Map<string, DeprecatedApiUsage[]>();
        for (const d of deprecated) {
            const existing = byFile.get(d.file) || [];
            existing.push(d);
            byFile.set(d.file, existing);
        }

        for (const [file, usages] of byFile) {
            // Separate security-deprecated (critical) from others (medium)
            const securityUsages = usages.filter(u => u.category === 'security');
            const otherUsages = usages.filter(u => u.category !== 'security');

            if (securityUsages.length > 0) {
                const details = securityUsages.map(u =>
                    `  L${u.line}: ${u.api} — ${u.reason} → Use ${u.replacement}`
                ).join('\n');
                failures.push(this.createFailure(
                    `Security-deprecated APIs in ${file}:\n${details}`,
                    [file],
                    `These APIs were deprecated for security reasons. Using them introduces known vulnerabilities. Replace with the suggested alternatives immediately.`,
                    'Security-Deprecated APIs',
                    securityUsages[0].line,
                    undefined,
                    this.config.block_security_deprecated ? 'critical' : 'high'
                ));
            }

            if (otherUsages.length > 0) {
                const details = otherUsages.map(u =>
                    `  L${u.line}: ${u.api} — ${u.reason} → Use ${u.replacement}`
                ).join('\n');
                failures.push(this.createFailure(
                    `Deprecated APIs in ${file}:\n${details}`,
                    [file],
                    `These APIs are deprecated or removed. AI models trained on older code frequently suggest them. Update to current alternatives.`,
                    'Deprecated APIs',
                    otherUsages[0].line,
                    undefined,
                    'medium'
                ));
            }
        }

        return failures;
    }

    private checkNodeDeprecated(content: string, file: string, deprecated: DeprecatedApiUsage[]): void {
        const lines = content.split('\n');

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const trimmed = line.trim();

            // Skip comments
            if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;

            for (const rule of NODE_DEPRECATED_RULES) {
                if (rule.pattern.test(line)) {
                    deprecated.push({
                        file, line: i + 1,
                        api: rule.api,
                        reason: rule.reason,
                        replacement: rule.replacement,
                        category: rule.category,
                    });
                }
            }
        }
    }

    private checkWebDeprecated(content: string, file: string, deprecated: DeprecatedApiUsage[]): void {
        const lines = content.split('\n');

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const trimmed = line.trim();
            if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;

            for (const rule of WEB_DEPRECATED_RULES) {
                if (rule.pattern.test(line)) {
                    deprecated.push({
                        file, line: i + 1,
                        api: rule.api,
                        reason: rule.reason,
                        replacement: rule.replacement,
                        category: rule.category,
                    });
                }
            }
        }
    }

    private checkPythonDeprecated(content: string, file: string, deprecated: DeprecatedApiUsage[]): void {
        const lines = content.split('\n');

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const trimmed = line.trim();
            if (trimmed.startsWith('#')) continue;

            for (const rule of PYTHON_DEPRECATED_RULES) {
                if (rule.pattern.test(line)) {
                    deprecated.push({
                        file, line: i + 1,
                        api: rule.api,
                        reason: rule.reason,
                        replacement: rule.replacement,
                        category: rule.category,
                    });
                }
            }
        }
    }

    private checkGoDeprecated(content: string, file: string, deprecated: DeprecatedApiUsage[]): void {
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const trimmed = line.trim();
            if (trimmed.startsWith('//')) continue;
            for (const rule of GO_DEPRECATED_RULES) {
                if (rule.pattern.test(line)) {
                    deprecated.push({
                        file, line: i + 1,
                        api: rule.api, reason: rule.reason,
                        replacement: rule.replacement, category: rule.category,
                    });
                }
            }
        }
    }

    private checkCSharpDeprecated(content: string, file: string, deprecated: DeprecatedApiUsage[]): void {
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const trimmed = line.trim();
            if (trimmed.startsWith('//') || trimmed.startsWith('/*')) continue;
            for (const rule of CSHARP_DEPRECATED_RULES) {
                if (rule.pattern.test(line)) {
                    deprecated.push({
                        file, line: i + 1,
                        api: rule.api, reason: rule.reason,
                        replacement: rule.replacement, category: rule.category,
                    });
                }
            }
        }
    }

    private checkJavaDeprecated(content: string, file: string, deprecated: DeprecatedApiUsage[]): void {
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const trimmed = line.trim();
            if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) continue;
            for (const rule of JAVA_DEPRECATED_RULES) {
                if (rule.pattern.test(line)) {
                    deprecated.push({
                        file, line: i + 1,
                        api: rule.api, reason: rule.reason,
                        replacement: rule.replacement, category: rule.category,
                    });
                }
            }
        }
    }
}

interface DeprecatedRule {
    pattern: RegExp;
    api: string;
    reason: string;
    replacement: string;
    category: 'security' | 'removed' | 'superseded';
}

/**
 * Node.js deprecated APIs — sourced from official Node.js deprecation list
 */
const NODE_DEPRECATED_RULES: DeprecatedRule[] = [
    // Security-deprecated
    {
        pattern: /new\s+Buffer\s*\(/,
        api: 'new Buffer()',
        reason: 'DEP0005: Security vulnerability — uninitialized memory exposure',
        replacement: 'Buffer.from(), Buffer.alloc(), or Buffer.allocUnsafe()',
        category: 'security',
    },
    {
        pattern: /Buffer\s*\(\s*(?:\d|['"])/,
        api: 'Buffer() constructor',
        reason: 'DEP0005: Security vulnerability — uninitialized memory exposure',
        replacement: 'Buffer.from(), Buffer.alloc(), or Buffer.allocUnsafe()',
        category: 'security',
    },
    {
        pattern: /createCipher\s*\(/,
        api: 'crypto.createCipher()',
        reason: 'DEP0106: Uses weak key derivation (no IV, no salt)',
        replacement: 'crypto.createCipheriv() with explicit IV',
        category: 'security',
    },
    {
        pattern: /createDecipher\s*\(/,
        api: 'crypto.createDecipher()',
        reason: 'DEP0106: Uses weak key derivation (no IV, no salt)',
        replacement: 'crypto.createDecipheriv() with explicit IV',
        category: 'security',
    },
    // Removed
    {
        pattern: /\brequire\s*\(\s*['"]domain['"]\s*\)/,
        api: "require('domain')",
        reason: 'DEP0032: domain module is deprecated (error handling issues)',
        replacement: 'async_hooks, try/catch, or Promise error handling',
        category: 'removed',
    },
    {
        pattern: /\brequire\s*\(\s*['"]punycode['"]\s*\)/,
        api: "require('punycode')",
        reason: 'DEP0040: punycode module removed from Node.js core',
        replacement: 'npm package: punycode (userland)',
        category: 'removed',
    },
    {
        pattern: /\brequire\s*\(\s*['"]sys['"]\s*\)/,
        api: "require('sys')",
        reason: 'DEP0025: sys module was renamed to util',
        replacement: "require('util')",
        category: 'removed',
    },
    {
        pattern: /\brequire\s*\(\s*['"]_linklist['"]\s*\)/,
        api: "require('_linklist')",
        reason: 'DEP0037: _linklist module removed',
        replacement: 'npm userland linked list package',
        category: 'removed',
    },
    // Superseded
    {
        pattern: /url\.parse\s*\(/,
        api: 'url.parse()',
        reason: 'DEP0169: Legacy URL parser has known vulnerabilities',
        replacement: 'new URL() (WHATWG URL API)',
        category: 'superseded',
    },
    {
        pattern: /url\.resolve\s*\(/,
        api: 'url.resolve()',
        reason: 'DEP0169: Legacy URL API',
        replacement: 'new URL(relative, base)',
        category: 'superseded',
    },
    {
        pattern: /url\.format\s*\(\s*(?:url\.parse|{)/,
        api: 'url.format(urlObject)',
        reason: 'DEP0169: Legacy URL API with url.parse objects',
        replacement: 'new URL().toString() or url.format(new URL(...))',
        category: 'superseded',
    },
    {
        pattern: /\.send\s*\(\s*new\s+Buffer\b/,
        api: 'Sending raw Buffer',
        reason: 'Potential uninitialized memory leak when Buffer() used without alloc',
        replacement: 'Buffer.from() or Buffer.alloc()',
        category: 'security',
    },
    {
        pattern: /fs\.exists\s*\(/,
        api: 'fs.exists()',
        reason: 'DEP0103: fs.exists() is deprecated (race condition issues)',
        replacement: 'fs.access() or fs.stat()',
        category: 'superseded',
    },
    {
        pattern: /util\.inherits\s*\(/,
        api: 'util.inherits()',
        reason: 'DEP0: Superseded by ES6 class extends',
        replacement: 'class Child extends Parent {}',
        category: 'superseded',
    },
    {
        pattern: /util\.pump\s*\(/,
        api: 'util.pump()',
        reason: 'DEP0004: Removed — use stream.pipeline()',
        replacement: 'stream.pipeline() or pipe()',
        category: 'removed',
    },
    {
        pattern: /util\.puts\s*\(|util\.print\s*\(|util\.debug\s*\(/,
        api: 'util.puts/print/debug()',
        reason: 'DEP0027/28/29: Removed console wrappers',
        replacement: 'console.log() / console.error()',
        category: 'removed',
    },
    {
        pattern: /SlowBuffer\s*\(/,
        api: 'SlowBuffer',
        reason: 'DEP0030: Deprecated class',
        replacement: 'Buffer.allocUnsafeSlow()',
        category: 'superseded',
    },
    {
        pattern: /\.setEncoding\s*\(\s*['"]binary['"]\s*\)/,
        api: "setEncoding('binary')",
        reason: "DEP0040: 'binary' encoding is deprecated",
        replacement: "'latin1' encoding",
        category: 'superseded',
    },
    {
        pattern: /process\.(?:assert|binding)\s*\(/,
        api: 'process.assert()/binding()',
        reason: 'DEP0064/0098: Internal APIs removed',
        replacement: 'assert module / public APIs',
        category: 'removed',
    },
];

/**
 * Web API deprecated patterns
 */
const WEB_DEPRECATED_RULES: DeprecatedRule[] = [
    {
        pattern: /document\.write\s*\(/,
        api: 'document.write()',
        reason: 'Blocks parsing, security risk (XSS vector), removed in strict mode',
        replacement: 'DOM manipulation (createElement, appendChild, innerHTML)',
        category: 'security',
    },
    {
        pattern: /\.innerHTML\s*=\s*[`'"]/,
        api: 'innerHTML assignment with strings',
        reason: 'XSS vulnerability when used with user-supplied content',
        replacement: 'textContent, createElement + appendChild, or DOMPurify.sanitize()',
        category: 'security',
    },
    {
        pattern: /eval\s*\(\s*[^)]/,
        api: 'eval()',
        reason: 'Code injection vulnerability, prevents optimization',
        replacement: 'JSON.parse(), Function constructor (if absolutely needed), or structured approach',
        category: 'security',
    },
    {
        pattern: /with\s*\(\s*\w/,
        api: 'with statement',
        reason: 'Removed in strict mode, creates ambiguous scope, security risk',
        replacement: 'Destructuring or explicit property access',
        category: 'removed',
    },
    {
        pattern: /document\.all\b/,
        api: 'document.all',
        reason: 'Legacy IE API, falsy object (quirks mode artifact)',
        replacement: 'document.getElementById(), document.querySelector()',
        category: 'superseded',
    },
    {
        pattern: /escape\s*\(\s*['"]/,
        api: 'escape()',
        reason: 'Deprecated — does not handle Unicode correctly',
        replacement: 'encodeURIComponent() or encodeURI()',
        category: 'superseded',
    },
    {
        pattern: /unescape\s*\(/,
        api: 'unescape()',
        reason: 'Deprecated — does not handle Unicode correctly',
        replacement: 'decodeURIComponent() or decodeURI()',
        category: 'superseded',
    },
];

/**
 * Python deprecated APIs — sourced from Python 3.12+ deprecation notices
 */
const PYTHON_DEPRECATED_RULES: DeprecatedRule[] = [
    // Security-deprecated
    {
        pattern: /\bmd5\s*\(|\.md5\s*\(/,
        api: 'hashlib.md5() for passwords',
        reason: 'MD5 is cryptographically broken — collision attacks proven since 2004',
        replacement: 'hashlib.sha256(), hashlib.blake2b(), or bcrypt/argon2 for passwords',
        category: 'security',
    },
    {
        pattern: /\bsha1\s*\(|\.sha1\s*\(/,
        api: 'hashlib.sha1() for security',
        reason: 'SHA-1 is cryptographically broken — SHAttered attack (2017)',
        replacement: 'hashlib.sha256() or hashlib.sha3_256()',
        category: 'security',
    },
    {
        pattern: /\bpickle\.loads?\s*\(/,
        api: 'pickle.load()/loads()',
        reason: 'Arbitrary code execution vulnerability when loading untrusted data',
        replacement: 'json.loads() for data, or use restricted_loads with allowlists',
        category: 'security',
    },
    {
        pattern: /\byaml\.load\s*\([^)]*(?!\bLoader\b)[^)]*\)/,
        api: 'yaml.load() without Loader',
        reason: 'Arbitrary code execution when loading untrusted YAML',
        replacement: 'yaml.safe_load() or yaml.load(data, Loader=yaml.SafeLoader)',
        category: 'security',
    },
    {
        pattern: /\bexec\s*\(\s*(?:input|request|f['"])/,
        api: 'exec() with user input',
        reason: 'Code injection vulnerability',
        replacement: 'ast.literal_eval() for data, structured parsing for expressions',
        category: 'security',
    },
    {
        pattern: /\bos\.system\s*\(/,
        api: 'os.system()',
        reason: 'Shell injection vulnerability, no output capture',
        replacement: 'subprocess.run() with shell=False',
        category: 'security',
    },
    {
        pattern: /subprocess\.(?:call|run|Popen)\s*\([^)]*shell\s*=\s*True/,
        api: 'subprocess with shell=True',
        reason: 'Shell injection vulnerability when args contain user input',
        replacement: 'subprocess.run() with shell=False and list args',
        category: 'security',
    },
    // Removed modules (Python 3.12+)
    {
        pattern: /\bimport\s+imp\b/,
        api: 'import imp',
        reason: 'Removed in Python 3.12 (PEP 594)',
        replacement: 'importlib',
        category: 'removed',
    },
    {
        pattern: /\bimport\s+(?:aifc|audioop|cgi|cgitb|chunk|crypt|imghdr|mailcap|msilib|nis|nntplib|ossaudiodev|pipes|sndhdr|spwd|sunau|telnetlib|uu|xdrlib)\b/,
        api: 'Dead batteries module',
        reason: 'Removed in Python 3.13 (PEP 594 — dead batteries)',
        replacement: 'PyPI equivalents (see PEP 594 for specific replacements)',
        category: 'removed',
    },
    {
        pattern: /\bfrom\s+distutils\b/,
        api: 'distutils',
        reason: 'Removed in Python 3.12 (PEP 632)',
        replacement: 'setuptools or build',
        category: 'removed',
    },
    {
        pattern: /\bimport\s+formatter\b/,
        api: 'import formatter',
        reason: 'Removed in Python 3.10',
        replacement: 'No direct replacement — use string formatting',
        category: 'removed',
    },
    // Superseded
    {
        pattern: /\bfrom\s+collections\s+import\s+(?:Mapping|MutableMapping|Sequence|MutableSequence|Set|MutableSet|Callable|Iterable|Iterator|Generator|Coroutine|Awaitable|AsyncIterable|AsyncIterator|AsyncGenerator|Hashable|Sized|Container|Collection|Reversible|MappingView|KeysView|ItemsView|ValuesView|ByteString)\b/,
        api: 'collections ABCs',
        reason: 'Removed in Python 3.10 — moved to collections.abc',
        replacement: 'from collections.abc import ...',
        category: 'removed',
    },
    {
        pattern: /\boptparse\b/,
        api: 'optparse',
        reason: 'Superseded since Python 3.2',
        replacement: 'argparse',
        category: 'superseded',
    },
    {
        pattern: /\bfrom\s+typing\s+import\s+(?:Dict|List|Set|Tuple|FrozenSet|Type|Deque|DefaultDict|OrderedDict|Counter|ChainMap|Awaitable|Coroutine|AsyncIterable|AsyncIterator|AsyncGenerator|Iterable|Iterator|Generator|Reversible|Container|Collection|Callable|AbstractSet|MutableSet|Mapping|MutableMapping|Sequence|MutableSequence|ByteString|MappingView|KeysView|ItemsView|ValuesView|ContextManager|AsyncContextManager|Pattern|Match)\b/,
        api: 'typing generics (Dict, List, etc.)',
        reason: 'Deprecated since Python 3.9 — use built-in generics (PEP 585)',
        replacement: 'dict[], list[], set[], tuple[] (lowercase built-in types)',
        category: 'superseded',
    },
    {
        pattern: /\bfrom\s+typing\s+import\s+(?:Optional|Union)\b/,
        api: 'typing.Optional / typing.Union',
        reason: 'Superseded in Python 3.10 — use X | Y syntax (PEP 604)',
        replacement: 'X | None instead of Optional[X], X | Y instead of Union[X, Y]',
        category: 'superseded',
    },
    {
        pattern: /\basyncio\.get_event_loop\s*\(\s*\)/,
        api: 'asyncio.get_event_loop()',
        reason: 'Deprecated in Python 3.10 — may create new loop unexpectedly',
        replacement: 'asyncio.get_running_loop() or asyncio.run()',
        category: 'superseded',
    },
    {
        pattern: /\bsetup\s*\(\s*[^)]*\buse_2to3\s*=/,
        api: 'setup(use_2to3=True)',
        reason: 'Removed in setuptools 58+ — Python 2 support dropped',
        replacement: 'Write Python 3 only code',
        category: 'removed',
    },
];

/**
 * Go deprecated APIs — sourced from Go official deprecation notices
 */
const GO_DEPRECATED_RULES: DeprecatedRule[] = [
    {
        pattern: /\bioutil\.ReadFile\s*\(/,
        api: 'ioutil.ReadFile()', reason: 'Deprecated since Go 1.16 — io/ioutil package deprecated',
        replacement: 'os.ReadFile()', category: 'superseded',
    },
    {
        pattern: /\bioutil\.WriteFile\s*\(/,
        api: 'ioutil.WriteFile()', reason: 'Deprecated since Go 1.16',
        replacement: 'os.WriteFile()', category: 'superseded',
    },
    {
        pattern: /\bioutil\.ReadAll\s*\(/,
        api: 'ioutil.ReadAll()', reason: 'Deprecated since Go 1.16',
        replacement: 'io.ReadAll()', category: 'superseded',
    },
    {
        pattern: /\bioutil\.ReadDir\s*\(/,
        api: 'ioutil.ReadDir()', reason: 'Deprecated since Go 1.16',
        replacement: 'os.ReadDir()', category: 'superseded',
    },
    {
        pattern: /\bioutil\.TempDir\s*\(/,
        api: 'ioutil.TempDir()', reason: 'Deprecated since Go 1.17',
        replacement: 'os.MkdirTemp()', category: 'superseded',
    },
    {
        pattern: /\bioutil\.TempFile\s*\(/,
        api: 'ioutil.TempFile()', reason: 'Deprecated since Go 1.17',
        replacement: 'os.CreateTemp()', category: 'superseded',
    },
    {
        pattern: /\bioutil\.NopCloser\s*\(/,
        api: 'ioutil.NopCloser()', reason: 'Deprecated since Go 1.16',
        replacement: 'io.NopCloser()', category: 'superseded',
    },
    {
        pattern: /\b"io\/ioutil"/,
        api: 'import "io/ioutil"', reason: 'Entire io/ioutil package deprecated since Go 1.16',
        replacement: 'Use os and io packages instead', category: 'superseded',
    },
    {
        pattern: /\bsort\.IntSlice\b|sort\.Float64Slice\b|sort\.StringSlice\b/,
        api: 'sort.*Slice types', reason: 'Superseded since Go 1.21',
        replacement: 'slices.Sort() or sort.Slice()', category: 'superseded',
    },
    {
        pattern: /\bmath\/rand"[\s\S]*?rand\.(Seed|Read)\s*\(/,
        api: 'rand.Seed() / rand.Read()', reason: 'Deprecated in Go 1.20+',
        replacement: 'Auto-seeded in Go 1.20+; use crypto/rand.Read()', category: 'superseded',
    },
    {
        pattern: /\bstrings\.Title\s*\(/,
        api: 'strings.Title()', reason: 'Deprecated since Go 1.18 — broken for Unicode',
        replacement: 'golang.org/x/text/cases.Title()', category: 'superseded',
    },
];

/**
 * C# deprecated APIs — sourced from .NET deprecation notices
 */
const CSHARP_DEPRECATED_RULES: DeprecatedRule[] = [
    {
        pattern: /\bnew\s+WebClient\s*\(/,
        api: 'WebClient', reason: 'Deprecated in .NET 6+ — poor async support',
        replacement: 'HttpClient', category: 'superseded',
    },
    {
        pattern: /\bBinaryFormatter\b/,
        api: 'BinaryFormatter', reason: 'Security vulnerability — arbitrary code execution on deserialization',
        replacement: 'System.Text.Json or JsonSerializer', category: 'security',
    },
    {
        pattern: /\bJavaScriptSerializer\b/,
        api: 'JavaScriptSerializer', reason: 'Deprecated — poor performance and limited features',
        replacement: 'System.Text.Json.JsonSerializer', category: 'superseded',
    },
    {
        pattern: /\bThread\.Abort\s*\(/,
        api: 'Thread.Abort()', reason: 'Throws PlatformNotSupportedException in .NET 5+',
        replacement: 'CancellationToken for cooperative cancellation', category: 'removed',
    },
    {
        pattern: /\bThread\.Suspend\s*\(|Thread\.Resume\s*\(/,
        api: 'Thread.Suspend/Resume()', reason: 'Deprecated — causes deadlocks',
        replacement: 'ManualResetEvent or SemaphoreSlim', category: 'removed',
    },
    {
        pattern: /\bAppDomain\.CreateDomain\s*\(/,
        api: 'AppDomain.CreateDomain()', reason: 'Not supported in .NET Core/5+',
        replacement: 'AssemblyLoadContext', category: 'removed',
    },
    {
        pattern: /\bRemoting\b.*\bChannel\b/,
        api: '.NET Remoting', reason: 'Removed in .NET Core/5+',
        replacement: 'gRPC, REST APIs, or SignalR', category: 'removed',
    },
    {
        pattern: /\bnew\s+SHA1(?:Managed|CryptoServiceProvider)\s*\(/,
        api: 'SHA1Managed/CryptoServiceProvider', reason: 'SHA-1 cryptographically broken',
        replacement: 'SHA256.Create() or SHA512.Create()', category: 'security',
    },
    {
        pattern: /\bnew\s+MD5CryptoServiceProvider\s*\(/,
        api: 'MD5CryptoServiceProvider', reason: 'MD5 cryptographically broken',
        replacement: 'SHA256.Create() or SHA512.Create()', category: 'security',
    },
    {
        pattern: /\bnew\s+(?:RijndaelManaged|DESCryptoServiceProvider|RC2CryptoServiceProvider|TripleDESCryptoServiceProvider)\s*\(/,
        api: 'Legacy crypto providers', reason: 'Weak encryption algorithms',
        replacement: 'Aes.Create()', category: 'security',
    },
];

/**
 * Java deprecated APIs — sourced from JDK deprecation notices
 */
const JAVA_DEPRECATED_RULES: DeprecatedRule[] = [
    {
        pattern: /\bnew\s+Date\s*\(\s*\d/,
        api: 'new Date(year, month, ...)', reason: 'Deprecated since JDK 1.1',
        replacement: 'java.time.LocalDate, LocalDateTime, ZonedDateTime', category: 'superseded',
    },
    {
        pattern: /\bnew\s+Vector\s*[<(]/,
        api: 'Vector', reason: 'Legacy synchronized collection — poor performance',
        replacement: 'ArrayList (or Collections.synchronizedList())', category: 'superseded',
    },
    {
        pattern: /\bnew\s+Hashtable\s*[<(]/,
        api: 'Hashtable', reason: 'Legacy synchronized map — poor performance',
        replacement: 'HashMap (or ConcurrentHashMap)', category: 'superseded',
    },
    {
        pattern: /\bnew\s+Stack\s*[<(]/,
        api: 'Stack', reason: 'Legacy class — extends Vector unnecessarily',
        replacement: 'Deque<> (ArrayDeque) with push/pop', category: 'superseded',
    },
    {
        pattern: /\bnew\s+StringBuffer\s*\(/,
        api: 'StringBuffer', reason: 'Unnecessarily synchronized — slower than StringBuilder',
        replacement: 'StringBuilder (unless thread safety needed)', category: 'superseded',
    },
    {
        pattern: /\.getYear\s*\(\s*\)(?!.*java\.time)/,
        api: 'Date.getYear()', reason: 'Deprecated since JDK 1.1 — returns year - 1900',
        replacement: 'LocalDate.now().getYear()', category: 'superseded',
    },
    {
        pattern: /Thread\.stop\s*\(/,
        api: 'Thread.stop()', reason: 'Deprecated — unsafe, can corrupt objects',
        replacement: 'Thread.interrupt() with cooperative checking', category: 'security',
    },
    {
        pattern: /Thread\.destroy\s*\(|Thread\.suspend\s*\(|Thread\.resume\s*\(/,
        api: 'Thread.destroy/suspend/resume()', reason: 'Deprecated — deadlock-prone',
        replacement: 'Thread.interrupt() and wait/notify', category: 'removed',
    },
    {
        pattern: /Runtime\.runFinalizersOnExit\s*\(/,
        api: 'Runtime.runFinalizersOnExit()', reason: 'Deprecated — inherently unsafe',
        replacement: 'Runtime shutdown hooks or try-with-resources', category: 'removed',
    },
    {
        pattern: /\bfinalize\s*\(\s*\)\s*(?:throws|\{)/,
        api: 'finalize()', reason: 'Deprecated since Java 9 (JEP 421) — for removal',
        replacement: 'Cleaner or try-with-resources (AutoCloseable)', category: 'superseded',
    },
    {
        pattern: /\bnew\s+Integer\s*\(|new\s+Long\s*\(|new\s+Double\s*\(|new\s+Boolean\s*\(|new\s+Float\s*\(/,
        api: 'new Integer/Long/Double/Boolean/Float()', reason: 'Deprecated since Java 9 — valueOf preferred',
        replacement: 'Integer.valueOf(), autoboxing, or parse methods', category: 'superseded',
    },
    {
        pattern: /\bSecurityManager\b/,
        api: 'SecurityManager', reason: 'Deprecated for removal since Java 17 (JEP 411)',
        replacement: 'No direct replacement — use OS-level security', category: 'removed',
    },
];
