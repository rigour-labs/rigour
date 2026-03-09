/**
 * Frontend Secret Exposure Gate
 *
 * Detects server-side secret keys (Stripe, OpenAI, AWS, etc.) referenced
 * in frontend-accessible files where they would be bundled into client JS.
 *
 * The "vibe-coded startup" attack pattern:
 *   process.env.STRIPE_SECRET_KEY inside a React component
 *   → bundled by webpack/Vite → visible in DevTools → $2,500 in fraudulent charges
 *
 * Two detection modes:
 *   1. Env-var name detection: process.env.VARNAME / import.meta.env.VARNAME
 *      where VARNAME matches secret_env_name_patterns and lacks a safe public prefix.
 *   2. Literal key detection: actual live API key values embedded in source
 *      (sk_live_..., sk-proj-..., AKIA..., ghp_..., etc.)
 */

import { Gate, GateContext } from './base.js';
import { Failure, Provenance } from '../types/index.js';
import { FileScanner } from '../utils/scanner.js';
import { Logger } from '../utils/logger.js';
import {
    LITERAL_KEY_PATTERNS, SEVERITY_ORDER, extractEnvVarName, extractDestructuredEnvVars,
} from './frontend-secret-patterns.js';
import fs from 'fs-extra';
import path from 'path';

export interface FrontendSecretExposureConfig {
    enabled?: boolean;
    block_on_severity?: 'critical' | 'high' | 'medium' | 'low';
    check_process_env?: boolean;
    check_import_meta_env?: boolean;
    secret_env_name_patterns?: string[];
    safe_public_prefixes?: string[];
    frontend_path_patterns?: string[];
    server_path_patterns?: string[];
    allowlist_env_names?: string[];
}

type FileContext = 'frontend' | 'server' | 'ambiguous';

interface SecretExposure {
    file: string;
    line: number;
    lineText: string;
    varName: string;
    kind: 'env-ref' | 'literal';
    serviceLabel: string;
    hint: string;
    cwe: string;
    severity: 'critical' | 'high' | 'medium' | 'low';
    fileContext: 'frontend' | 'ambiguous';
}


export class FrontendSecretExposureGate extends Gate {
    private cfg: Required<FrontendSecretExposureConfig>;
    private secretNamePatterns: RegExp[];
    private safePrefixPatterns: RegExp[];
    private frontendPathPatterns: RegExp[];
    private serverPathPatterns: RegExp[];

    constructor(config: FrontendSecretExposureConfig = {}) {
        super('frontend-secret-exposure', 'Frontend Secret Exposure');
        this.cfg = {
            enabled: config.enabled ?? true,
            block_on_severity: config.block_on_severity ?? 'high',
            check_process_env: config.check_process_env ?? true,
            check_import_meta_env: config.check_import_meta_env ?? true,
            secret_env_name_patterns: config.secret_env_name_patterns ?? [
                '(?:^|_)(?:secret|private)(?:_|$)',
                '(?:^|_)(?:token|api[_-]?key|access[_-]?key|client[_-]?secret|signing|webhook)(?:_|$)',
                '(?:^|_)(?:db[_-]?url|database[_-]?url|connection[_-]?string)(?:_|$)',
            ],
            safe_public_prefixes: config.safe_public_prefixes ?? [
                'NEXT_PUBLIC_', 'VITE_', 'PUBLIC_', 'NUXT_PUBLIC_', 'REACT_APP_',
            ],
            frontend_path_patterns: config.frontend_path_patterns ?? [
                '(^|/)pages/(?!api/)',
                '(^|/)components/',
                '(^|/)src/components/',
                '(^|/)src/views/',
                '(^|/)src/app/',
                '(^|/)app/(?!api/)',
                '(^|/)views/',
                '(^|/)public/',
            ],
            server_path_patterns: config.server_path_patterns ?? [
                '(^|/)pages/api/',
                '(^|/)src/pages/api/',
                '(^|/)app/api/',
                '(^|/)src/app/api/',
                '\\.server\\.(?:ts|tsx|js|jsx|mjs|cjs)$',
            ],
            allowlist_env_names: config.allowlist_env_names ?? [],
        };

        this.secretNamePatterns = this.cfg.secret_env_name_patterns.map(
            p => new RegExp(p, 'i')
        );
        // Escape prefix strings to safe regex literals
        this.safePrefixPatterns = this.cfg.safe_public_prefixes.map(
            prefix => new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)
        );
        this.frontendPathPatterns = this.cfg.frontend_path_patterns.map(p => new RegExp(p));
        this.serverPathPatterns = this.cfg.server_path_patterns.map(p => new RegExp(p));
    }

    protected get provenance(): Provenance { return 'security'; }

    async run(context: GateContext): Promise<Failure[]> {
        if (!this.cfg.enabled) return [];

        const scanPatterns = context.patterns || ['**/*.{ts,tsx,js,jsx,mjs,cjs,vue,svelte}'];
        const files = await FileScanner.findFiles({
            cwd: context.cwd,
            patterns: scanPatterns,
            ignore: [
                ...(context.ignore || []),
                '**/node_modules/**', '**/dist/**', '**/build/**',
                '**/.next/**', '**/coverage/**', '**/out/**',
            ],
        });

        // Skip test/fixture files — they routinely use dummy keys
        const sourceFiles = files.filter(f => !this.isTestFile(f));

        Logger.info(`Frontend Secret Exposure Gate: scanning ${sourceFiles.length} files`);

        const exposures: SecretExposure[] = [];

        for (const file of sourceFiles) {
            const fileContext = this.classifyFile(file);
            if (fileContext === 'server') continue;

            try {
                const fullPath = path.join(context.cwd, file);
                const content = await fs.readFile(fullPath, 'utf-8');

                // Skip files guarded by Next.js server-only import
                if (/import\s+['"]server-only['"]/.test(content)) continue;

                this.scanFile(content, file, fileContext as 'frontend' | 'ambiguous', exposures);
            } catch {
                // Unreadable — skip silently
            }
        }

        return this.toFailures(exposures);
    }

    /** Classify a file path as frontend, server, or ambiguous based on config patterns. */
    private classifyFile(file: string): FileContext {
        const n = file.replace(/\\/g, '/');
        // Server paths take priority over frontend paths
        if (this.serverPathPatterns.some(p => p.test(n))) return 'server';
        if (this.frontendPathPatterns.some(p => p.test(n))) return 'frontend';
        return 'ambiguous';
    }

    /** Test/fixture files are excluded — they legitimately contain dummy keys. */
    private isTestFile(file: string): boolean {
        const n = file.replace(/\\/g, '/');
        return /\.(test|spec)\.(ts|tsx|js|jsx)$/.test(n)
            || /\/__tests__\//.test(n)
            || /\/(?:fixtures|mocks|stubs)\//.test(n);
    }

    /**
     * Check whether a var name looks like a server-side secret:
     * - Matches at least one secret_env_name_pattern
     * - Does NOT start with a safe public prefix
     * - Is NOT in the user allowlist
     */
    private isSecretVar(varName: string): boolean {
        if (this.cfg.allowlist_env_names.includes(varName)) return false;
        if (this.safePrefixPatterns.some(p => p.test(varName))) return false;
        return this.secretNamePatterns.some(p => p.test(varName));
    }

    /** Scan one file for env-var references and literal key values. */
    private scanFile(
        content: string,
        file: string,
        fileContext: 'frontend' | 'ambiguous',
        out: SecretExposure[],
    ): void {
        const lines = content.split('\n');

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const lineNum = i + 1;

            // Skip comment lines to avoid flagging docs/examples
            const trimmed = line.trimStart();
            if (
                trimmed.startsWith('//') ||
                trimmed.startsWith('*') ||
                trimmed.startsWith('#') ||
                trimmed.startsWith('<!--')
            ) continue;

            // 1. Env-var name detection (process.env / import.meta.env)
            if (this.cfg.check_process_env || this.cfg.check_import_meta_env) {
                const single = extractEnvVarName(
                    line,
                    this.cfg.check_process_env,
                    this.cfg.check_import_meta_env,
                );
                if (single && this.isSecretVar(single)) {
                    out.push(this.makeEnvRefExposure(file, lineNum, line, single, fileContext));
                }

                // Destructuring: const { STRIPE_SECRET_KEY } = process.env
                if (this.cfg.check_process_env) {
                    for (const varName of extractDestructuredEnvVars(line)) {
                        if (this.isSecretVar(varName)) {
                            out.push(this.makeEnvRefExposure(file, lineNum, line, varName, fileContext));
                        }
                    }
                }
            }

            // 2. Literal API key detection
            for (const pattern of LITERAL_KEY_PATTERNS) {
                pattern.regex.lastIndex = 0;
                let m: RegExpExecArray | null;
                while ((m = pattern.regex.exec(line)) !== null) {
                    // Skip dummy/placeholder values and test-mode keys
                    if (this.isDummyValue(m[0])) continue;
                    if (/(?:sk_test_|pk_test_|_test_|_sandbox_)/i.test(m[0])) continue;

                    out.push({
                        file,
                        line: lineNum,
                        lineText: line.trim().slice(0, 80),
                        varName: m[0].slice(0, 24) + (m[0].length > 24 ? '...' : ''),
                        kind: 'literal',
                        serviceLabel: pattern.label,
                        hint: pattern.hint,
                        cwe: pattern.cwe,
                        severity: pattern.severity,
                        fileContext,
                    });
                }
            }
        }
    }

    private makeEnvRefExposure(
        file: string,
        line: number,
        lineText: string,
        varName: string,
        fileContext: 'frontend' | 'ambiguous',
    ): SecretExposure {
        // Definite frontend → critical; ambiguous → high (may be a shared util)
        const severity: 'critical' | 'high' = fileContext === 'frontend' ? 'critical' : 'high';
        return {
            file,
            line,
            lineText: lineText.trim().slice(0, 80),
            varName,
            kind: 'env-ref',
            serviceLabel: 'Secret Env Var',
            hint:
                `\`${varName}\` looks like a server-side secret but is referenced in a ` +
                `client-bundled file. Use an API route (Next.js /api, Remix action, ` +
                `Nuxt server route) to proxy calls instead of exposing the secret to the browser.`,
            cwe: 'CWE-312',
            severity,
            fileContext,
        };
    }

    /** Filters out trivial dummy/placeholder text to reduce false positives. */
    private isDummyValue(text: string): boolean {
        return /(?:example|placeholder|your[_-]|xxx+|dummy|fake|changeme)/i.test(text);
    }

    private toFailures(exposures: SecretExposure[]): Failure[] {
        if (exposures.length === 0) return [];

        const blockThreshold = SEVERITY_ORDER[this.cfg.block_on_severity];

        // Deduplicate: same file + line + varName from parallel patterns
        const seen = new Set<string>();
        const unique = exposures.filter(e => {
            const key = `${e.file}:${e.line}:${e.varName}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });

        // Sort critical first
        unique.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);

        const failures: Failure[] = [];

        for (const exp of unique) {
            if (SEVERITY_ORDER[exp.severity] > blockThreshold) continue;

            const ctx = exp.fileContext === 'frontend' ? '[definite frontend]' : '[possible frontend]';
            const kind = exp.kind === 'literal' ? 'literal key' : 'env var ref';

            failures.push(this.createFailure(
                `[${exp.cwe}] ${exp.serviceLabel} (${kind}) in ${ctx} file — ` +
                `\`${exp.varName}\` at line ${exp.line}`,
                [exp.file],
                exp.hint,
                `Security: Frontend Secret Exposure — ${exp.serviceLabel}`,
                exp.line,
                exp.line,
                exp.severity,
            ));
        }

        if (unique.length > 0 && failures.length === 0) {
            Logger.info(
                `Frontend Secret Exposure: ${unique.length} issue(s) below ` +
                `${this.cfg.block_on_severity} threshold`
            );
        }

        return failures;
    }
}
