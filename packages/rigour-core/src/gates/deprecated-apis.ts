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
 */

import { codeColumns } from '../utils/code-mask.js';
import { Gate, GateContext } from './base.js';
import { Failure, Provenance } from '../types/index.js';
import { FileScanner } from '../utils/scanner.js';
import { Logger } from '../utils/logger.js';
import { languageAdapters } from './language-adapters/index.js';
import { findWithStatements } from './deprecated-apis-ast.js';
import fs from 'fs-extra';
import path from 'path';
import { DeprecatedRule, NODE_DEPRECATED_RULES, WEB_DEPRECATED_RULES, PYTHON_DEPRECATED_RULES, GO_DEPRECATED_RULES, CSHARP_DEPRECATED_RULES, JAVA_DEPRECATED_RULES } from './deprecated-apis-rules.js';

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
    block_security_deprecated?: boolean;  // Opt in: security-deprecated is critical and blocks (default: high, a note)
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
            block_security_deprecated: config.block_security_deprecated ?? false,
            ignore_patterns: config.ignore_patterns ?? [],
        };
    }

    protected get provenance(): Provenance { return 'ai-drift'; }

    async run(context: GateContext): Promise<Failure[]> {
        if (!this.config.enabled) return [];

        const failures: Failure[] = [];
        const deprecated: DeprecatedApiUsage[] = [];

        const defaultPatterns = ['**/*.{ts,js,tsx,jsx,py,go,cs,java,kt}'];
        const scanPatterns = context.patterns || defaultPatterns;
        const files = await FileScanner.findFiles({
            cwd: context.cwd,
            patterns: scanPatterns,
            ignore: [...(context.ignore || []), '**/node_modules/**', '**/dist/**', '**/build/**',
                '**/*.test.*', '**/*.spec.*', '**/__tests__/**',
                // Python and Go tests: a deprecated call there is the test's business, not shipped code.
                '**/test_*.py', '**/*_test.py', '**/conftest.py', '**/tests/**', '**/*_test.go',
                '**/.venv/**', '**/venv/**', '**/vendor/**', '**/__pycache__/**',
                '**/bin/Debug/**', '**/bin/Release/**', '**/obj/**',
                '**/target/**', '**/.gradle/**', '**/out/**'],
        });
        const analyzableFiles = files.filter(file => !this.shouldSkipFile(file));

        Logger.info(`Deprecated APIs: Scanning ${analyzableFiles.length} files`);

        for (const file of analyzableFiles) {
            try {
                const fullPath = path.join(context.cwd, file);
                const content = await fs.readFile(fullPath, 'utf-8');
                const adapter = languageAdapters.getAdapter(file);
                if (!adapter) continue;

                /** Map adapter IDs to config flags */
                const configCheck: Record<string, boolean> = {
                    js: this.config.check_node,
                    python: this.config.check_python,
                    go: this.config.check_go,
                    csharp: this.config.check_csharp,
                    java: this.config.check_java,
                };
                if (configCheck[adapter.id] === false) continue;

                switch (adapter.id) {
                    case 'js':
                        if (this.config.check_node) this.checkNodeDeprecated(content, file, deprecated);
                        if (this.config.check_web) {
                            this.checkWebDeprecated(content, file, deprecated);
                            for (const w of findWithStatements(content, file)) deprecated.push({ file, ...w });
                        }
                        break;
                    case 'python':
                        this.checkPythonDeprecated(content, file, deprecated);
                        break;
                    case 'go':
                        this.checkGoDeprecated(content, file, deprecated);
                        break;
                    case 'csharp':
                        this.checkCSharpDeprecated(content, file, deprecated);
                        break;
                    case 'java':
                        this.checkJavaDeprecated(content, file, deprecated);
                        break;
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
                failures.push({ ...this.createFailure(
                    `Security-deprecated APIs in ${file}:\n${details}`,
                    [file],
                    `These APIs were deprecated for security reasons. Using them introduces known vulnerabilities. Replace with the suggested alternatives immediately.`,
                    'Security-Deprecated APIs',
                    securityUsages[0].line,
                    undefined,
                    this.config.block_security_deprecated ? 'critical' : 'high'
                ), lines: securityUsages.map(item => item.line),
                // Deprecated is not vulnerable (md5 for a cache key, shell=True with a constant): likely, shown, never a
                // block, unless the team opts in, and then its own choice makes it a block.
                certainty: this.config.block_security_deprecated ? 'proven' : 'likely' });
            }

            if (otherUsages.length > 0) {
                const details = otherUsages.map(u =>
                    `  L${u.line}: ${u.api} — ${u.reason} → Use ${u.replacement}`
                ).join('\n');
                failures.push({ ...this.createFailure(
                    `Deprecated APIs in ${file}:\n${details}`,
                    [file],
                    `These APIs are deprecated or removed. AI models trained on older code frequently suggest them. Update to current alternatives.`,
                    'Deprecated APIs',
                    otherUsages[0].line,
                    undefined,
                    'medium'
                ), lines: otherUsages.map(item => item.line) });
            }
        }

        return failures;
    }

    private shouldSkipFile(file: string): boolean {
        const normalized = file.replace(/\\/g, '/');
        return (
            this.config.ignore_patterns.some(pattern => new RegExp(pattern).test(normalized)) ||
            normalized.includes('/examples/') ||
            normalized.includes('/__tests__/') ||
            normalized.endsWith('/deprecated-apis-rules-node.ts') ||
            normalized.endsWith('/deprecated-apis-rules-lang.ts') ||
            normalized.endsWith('/deprecated-apis-rules.ts') ||
            /\.test\.[^.]+$/i.test(normalized) ||
            /\.spec\.[^.]+$/i.test(normalized)
        );
    }

    private checkNodeDeprecated(content: string, file: string, deprecated: DeprecatedApiUsage[]): void {
        const lines = content.split('\n');

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const trimmed = line.trim();

            // Skip comments
            if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;

            for (const rule of NODE_DEPRECATED_RULES) {
                if (callIn(line, rule.pattern, file)) {
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
                if (callIn(line, rule.pattern, file)) {
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
                if (callIn(line, rule.pattern, file)) {
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
                if (callIn(line, rule.pattern, file)) {
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
                if (callIn(line, rule.pattern, file)) {
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
                if (callIn(line, rule.pattern, file)) {
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

/**
 * Whether a rule matches this line where it is code: every match is tried, and one that starts in a string literal or a
 * comment (utils/code-mask.ts) is not a use of the API. Every rule here is a call or an import.
 */
function callIn(line: string, pattern: RegExp, file: string): boolean {
    if (!pattern.test(line)) return false;
    const isCode = codeColumns(line, path.extname(file).slice(1));
    const every = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
    for (const m of line.matchAll(every)) if (isCode(m.index ?? 0)) return true;
    return false;
}
