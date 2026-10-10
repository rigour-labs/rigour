/**
 * Security Patterns Gate
 *
 * Detects code-level security vulnerabilities for frontier models
 * that may generate insecure patterns at scale.
 *
 * Patterns covered:
 * - SQL Injection
 * - XSS (Cross-Site Scripting)
 * - Path Traversal
 * - Hardcoded Secrets
 * - Insecure Randomness
 * - Command Injection
 */

import { codeOffsets } from '../utils/code-mask.js';
import { Gate, GateContext } from './base.js';
import { Failure, Provenance } from '../types/index.js';
import { FileScanner } from '../utils/scanner.js';
import { Logger } from '../utils/logger.js';
import { FIX_BY_TYPE, FIX_UNKNOWN, VULNERABILITY_PATTERNS } from './security-patterns-data.js';
import { findUnsafeShellCalls } from './security-command-execution.js';
import fs from 'fs-extra';
import path from 'path';

export interface SecurityVulnerability {
    type: string;
    severity: 'critical' | 'high' | 'medium' | 'low';
    file: string;
    line: number;
    match: string;
    description: string;
    cwe?: string;
    /** The pattern is a credential format only a real secret has (security-patterns-data.ts `proven`). */
    proven?: true;
}

/** The fix for this kind of finding, after what was found; a secret is shown by its first characters only. */
export function securityHint(vuln: Pick<SecurityVulnerability, 'type' | 'match'>): string {
    const found = vuln.type === 'hardcoded_secrets' ? `${vuln.match.slice(0, 4)}…` : `${vuln.match.slice(0, 60)}…`;
    return `Found: "${found}". ${FIX_BY_TYPE[vuln.type] ?? FIX_UNKNOWN}`;
}

export interface SecurityPatternsConfig {
    enabled?: boolean;
    sql_injection?: boolean;
    xss?: boolean;
    path_traversal?: boolean;
    hardcoded_secrets?: boolean;
    insecure_randomness?: boolean;
    command_injection?: boolean;
    redos?: boolean;
    overly_permissive?: boolean;
    unsafe_output?: boolean;
    missing_input_validation?: boolean;
    block_on_severity?: 'critical' | 'high' | 'medium' | 'low';
    /** Opt in: every pattern blocks, not only the credential formats. */
    block?: boolean;
}


/**
 * A provider's documented example or placeholder key, which docs, comments and SDK samples carry everywhere: AWS's
 * documented example access key (the one ending in EXAMPLE), or a Stripe live key of all x's or 0's or spelling out
 * "your". A proven pattern never fires on one. No key is spelled out here: the release scan refuses any tarball with
 * a credential-shaped string, whoever's it is.
 */
export function isDocumentedExampleKey(match: string): boolean {
    // Each exclusion is scoped to its own key shape: a random token (ghp_, sk-) can contain "your" by chance.
    return /^AKIA[0-9A-Z]*EXAMPLE$/.test(match) || /^(?:sk|rk)_live_(?:x+|0+)$/i.test(match) || /^(?:sk|rk)_live_\w*your/i.test(match);
}

export class SecurityPatternsGate extends Gate {
    private config: SecurityPatternsConfig;
    private severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };

    constructor(config: SecurityPatternsConfig = {}) {
        super('security-patterns', 'Security Pattern Detection');
        this.config = {
            enabled: config.enabled ?? true,
            sql_injection: config.sql_injection ?? true,
            xss: config.xss ?? true,
            path_traversal: config.path_traversal ?? true,
            hardcoded_secrets: config.hardcoded_secrets ?? true,
            insecure_randomness: config.insecure_randomness ?? true,
            command_injection: config.command_injection ?? true,
            redos: config.redos ?? true,
            overly_permissive: config.overly_permissive ?? true,
            unsafe_output: config.unsafe_output ?? true,
            missing_input_validation: config.missing_input_validation ?? true,
            block_on_severity: config.block_on_severity ?? 'high',
            block: config.block ?? false,
        };
    }

    protected get provenance(): Provenance { return 'security'; }

    async run(context: GateContext): Promise<Failure[]> {
        if (!this.config.enabled) {
            return [];
        }

        const failures: Failure[] = [];
        const vulnerabilities: SecurityVulnerability[] = [];

        const scanPatterns = context.patterns || ['**/*.{ts,js,tsx,jsx,py,java,go}'];
        const files = await FileScanner.findFiles({
            cwd: context.cwd,
            patterns: scanPatterns,
            ignore: [...(context.ignore || []), '**/node_modules/**', '**/dist/**', '**/build/**', '**/.next/**', '**/coverage/**'],
        });

        const scanFiles = files.filter(file => !this.shouldSkipSecurityFile(file));
        Logger.info(`Security Patterns Gate: Scanning ${scanFiles.length} files`);

        for (const file of scanFiles) {
            try {
                const fullPath = path.join(context.cwd, file);
                const content = await fs.readFile(fullPath, 'utf-8');
                const ext = path.extname(file).slice(1);

                this.scanFileForVulnerabilities(content, file, ext, vulnerabilities);
            } catch (e) { }
        }

        // Filter by enabled checks
        const filteredVulns = vulnerabilities.filter(v => {
            switch (v.type) {
                case 'sql_injection': return this.config.sql_injection;
                case 'xss': return this.config.xss;
                case 'path_traversal': return this.config.path_traversal;
                case 'hardcoded_secrets': return this.config.hardcoded_secrets;
                case 'insecure_randomness': return this.config.insecure_randomness;
                case 'command_injection': return this.config.command_injection;
                case 'redos': return this.config.redos;
                case 'overly_permissive': return this.config.overly_permissive;
                case 'unsafe_output': return this.config.unsafe_output;
                case 'missing_input_validation': return this.config.missing_input_validation;
                default: return true;
            }
        });

        // Sort by severity
        filteredVulns.sort((a, b) =>
            this.severityOrder[a.severity] - this.severityOrder[b.severity]
        );

        // Convert to failures based on block_on_severity threshold
        const blockThreshold = this.severityOrder[this.config.block_on_severity ?? 'high'];

        for (const vuln of filteredVulns) {
            if (this.severityOrder[vuln.severity] <= blockThreshold) {
                // A credential format is the fact itself: proven. Every other pattern cannot see whether its input is
                // trusted (a constant, an allow-listed value): likely, unless the team opts in (security.block).
                failures.push({
                    ...this.createFailure(
                        `[${vuln.cwe}] ${vuln.description}`,
                        [vuln.file],
                        securityHint(vuln),
                        `Security: ${vuln.type.replace('_', ' ').toUpperCase()}`,
                        vuln.line,
                        vuln.line,
                        vuln.severity
                    ),
                    certainty: vuln.proven || this.config.block ? 'proven' : 'likely',
                });
            }
        }

        if (filteredVulns.length > 0 && failures.length === 0) {
            // Vulnerabilities found but below threshold - log info
            Logger.info(`Security scan found ${filteredVulns.length} issues below ${this.config.block_on_severity} threshold`);
        }

        return failures;
    }

    private shouldSkipSecurityFile(file: string): boolean {
        const normalized = file.replace(/\\/g, '/');
        // Skip common non-source directories
        if (/\/(?:examples|studio-dist|dist|build|coverage|target|out)\//.test(`/${normalized}`)) return true;
        // Skip test directories: __tests__/, tests/, test/, __test__/, e2e/, fixtures/, mocks/
        if (/\/(?:__tests__|tests|test|__test__|e2e|fixtures|mocks)\//.test(`/${normalized}`)) return true;
        if (/\/commands\/demo(?:-|\/)/.test(`/${normalized}`)) return true;
        if (/\/gates\/deprecated-apis-rules(?:-node|-lang)?\.ts$/i.test(normalized)) return true;
        // Skip test files: *.test.ts, *.spec.ts (JS/TS/Java)
        if (/\.(test|spec)\.(?:ts|tsx|js|jsx|py|java|go)$/i.test(normalized)) return true;
        // Skip Go test files: *_test.go
        if (/_test\.go$/i.test(normalized)) return true;
        // Skip Python test files: test_*.py, *_test.py, conftest.py
        if (/(?:^|\/)test_[^/]+\.py$/i.test(normalized)) return true;
        if (/_test\.py$/i.test(normalized)) return true;
        if (/(?:^|\/)conftest\.py$/i.test(normalized)) return true;
        // Skip Java/Kotlin test files in src/test/ directories
        if (/\/src\/test\//.test(`/${normalized}`)) return true;
        // Skip E2E test files by naming convention
        if (/[._-]e2e[._-]/i.test(normalized) || /E2E/i.test(path.basename(normalized))) return true;
        return false;
    }

    private scanFileForVulnerabilities(
        content: string,
        file: string,
        ext: string,
        vulnerabilities: SecurityVulnerability[]
    ): void {
        if (ext === 'ts' || ext === 'js') {
            for (const call of findUnsafeShellCalls(content, file)) {
                vulnerabilities.push({
                    type: 'command_injection', severity: 'critical', file,
                    line: call.line, match: call.text,
                    description: 'Potential command injection: shell execution with user input',
                    cwe: 'CWE-78',
                });
            }
        }

        // A call written in a message or a comment is not a call: a pattern of that kind counts only from code.
        const isCode = codeOffsets(content, ext);
        for (const pattern of VULNERABILITY_PATTERNS) {
            // Check if pattern applies to this file type
            if (!pattern.languages.includes('*') && !pattern.languages.includes(ext)) {
                continue;
            }

            // Reset regex state
            pattern.regex.lastIndex = 0;

            let match;
            while ((match = pattern.regex.exec(content)) !== null) {
                if (pattern.where !== 'anywhere' && !isCode(match.index)) continue;
                // For hardcoded_secrets: filter out placeholder/dummy values and env var names
                if (pattern.type === 'hardcoded_secrets' && (this.isDummySecretValue(match[0]) || isDocumentedExampleKey(match[0]))) {
                    continue;
                }

                // For XSS: check if innerHTML/dangerouslySetInnerHTML is wrapped in a sanitizer
                if (pattern.type === 'xss' && this.isSanitizedAssignment(match[0])) {
                    continue;
                }

                // Find line number
                const beforeMatch = content.slice(0, match.index);
                const lineNumber = beforeMatch.split('\n').length;

                vulnerabilities.push({
                    type: pattern.type,
                    severity: pattern.severity,
                    file,
                    line: lineNumber,
                    match: match[0],
                    description: pattern.description,
                    cwe: pattern.cwe,
                    ...(pattern.proven ? { proven: true as const } : {}),
                });
            }
        }
    }

    /**
     * Check if a hardcoded secret match is actually a dummy/placeholder value.
     * Filters out test values, placeholder defaults, env-var-name assignments,
     * store action types, and low-entropy constants.
     */
    private isDummySecretValue(matchText: string): boolean {
        // Extract the quoted value from the match (e.g., api_key="test-api-key" → test-api-key)
        const valueMatch = matchText.match(/[:=]\s*['"]([^'"]+)['"]/);
        if (!valueMatch) return false;

        const value = valueMatch[1];

        // Placeholder/example patterns
        if (/^(?:your[_-]|my[_-]|example[_-]|placeholder|changeme|replace[_-]me|xxx+|dummy|fake|sample)/i.test(value)) return true;

        // Test-specific dummy values
        if (/^(?:test[_-]|e2e[_-]|mock[_-]|stub[_-]|dev[_-])/i.test(value)) return true;
        if (/^testpass(?:word)?$/i.test(value)) return true;

        // All-caps with underscores/dollars = env var names or constants, not actual secrets
        // e.g., API_KEY = "OPEN_SANDBOX_API_KEY", SECRETS$ADD_SECRET (Redux action types)
        if (/^[A-Z][A-Z0-9_$]{7,}$/.test(value)) return true;

        // Store action type patterns: NAMESPACE$ACTION or namespace/ACTION (Redux, Zustand, Flux)
        if (/^\w+\$\w+$/.test(value)) return true;
        if (/^[a-z][\w-]*\/[A-Z_]+$/.test(value)) return true;

        // Common documentation/tutorial dummy values
        if (/^(?:sk_test_|pk_test_|sk_live_xxx|password123|secret123|abcdef|abc123)/i.test(value)) return true;

        // Shannon entropy check: low-entropy values are likely constants, not real secrets
        // Real secrets have high entropy (>4.0 bits/char); constants and names have low entropy
        if (this.shannonEntropy(value) < 3.0) return true;

        // ALL_CAPS_SNAKE_CASE without any lowercase/special chars = likely enum or constant
        if (/^[A-Z][A-Z0-9_$]*$/.test(value) && value.length >= 6) return true;

        // URL-like values that are just config (not secrets): localhost, 127.0.0.1, etc.
        if (/^(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|0\.0\.0\.0)/.test(value)) return true;

        // Common non-secret patterns: UUIDs, semver, file paths
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return true;
        if (/^\d+\.\d+\.\d+/.test(value)) return true; // semver

        return false;
    }

    /**
     * Calculate Shannon entropy (bits per character) of a string.
     * Real secrets have high entropy (>4.5); constants/names have low entropy (<3.0).
     */
    private shannonEntropy(str: string): number {
        if (!str || str.length === 0) return 0;
        const freq = new Map<string, number>();
        for (const ch of str) {
            freq.set(ch, (freq.get(ch) || 0) + 1);
        }
        let entropy = 0;
        for (const count of freq.values()) {
            const p = count / str.length;
            if (p > 0) entropy -= p * Math.log2(p);
        }
        return entropy;
    }

    /**
     * Check if an innerHTML or dangerouslySetInnerHTML assignment is wrapped in a sanitizer.
     * Known sanitizers: DOMPurify.sanitize(), sanitize(), xss(), escapeHtml(), htmlEncode().
     */
    private isSanitizedAssignment(matchText: string): boolean {
        const sanitizers = [
            'sanitize(', 'DOMPurify.sanitize(', 'dompurify.sanitize(',
            'xss(', 'escape(', 'escapeHtml(', 'htmlEncode(',
            'sanitizeHtml(', 'clean(', 'purify(',
        ];
        const rhs = matchText.includes('=') ? matchText.split('=').slice(1).join('=') : matchText;
        return sanitizers.some(s => rhs.toLowerCase().includes(s.toLowerCase()));
    }

}

/**
 * Quick helper to check a single file for security issues
 */
export async function checkSecurityPatterns(
    filePath: string,
    config: SecurityPatternsConfig = { enabled: true }
): Promise<SecurityVulnerability[]> {
    const gate = new SecurityPatternsGate(config);
    const content = await fs.readFile(filePath, 'utf-8');
    const ext = path.extname(filePath).slice(1);
    const vulnerabilities: SecurityVulnerability[] = [];

    // Use the private method via reflection for testing
    (gate as any).scanFileForVulnerabilities(content, filePath, ext, vulnerabilities);

    return vulnerabilities;
}
