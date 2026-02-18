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
