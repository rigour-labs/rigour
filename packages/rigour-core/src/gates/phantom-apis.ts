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
import { PhantomRule, GO_PHANTOM_RULES, CSHARP_PHANTOM_RULES, JAVA_PHANTOM_RULES, NODE_STDLIB_METHODS, PYTHON_STDLIB_METHODS } from './phantom-apis-data.js';

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