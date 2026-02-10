import { Gate, GateContext } from './base.js';
import { Failure, Gates } from '../types/index.js';
import { FileScanner } from '../utils/scanner.js';
import { Logger } from '../utils/logger.js';
import fs from 'fs-extra';
import path from 'path';

/**
 * Extended Context Configuration (v2.14+)
 * For 1M token frontier models like Opus 4.6
 */
export interface ExtendedContextConfig {
    enabled?: boolean;
    sensitivity?: number;
    mining_depth?: number;
    cross_file_patterns?: boolean;  // NEW: Enable cross-file pattern analysis
    naming_consistency?: boolean;   // NEW: Check naming convention drift
    import_relationships?: boolean; // NEW: Validate import patterns
    max_cross_file_depth?: number;  // NEW: How many related files to analyze
}

export class ContextGate extends Gate {
    private extendedConfig: ExtendedContextConfig;

    constructor(private config: Gates) {
        super('context-drift', 'Context Awareness & Drift Detection');
        this.extendedConfig = {
            enabled: config.context?.enabled ?? false,
            sensitivity: config.context?.sensitivity ?? 0.8,
            mining_depth: config.context?.mining_depth ?? 100,
            cross_file_patterns: true,  // Default ON for frontier model support
            naming_consistency: true,
            import_relationships: true,
            max_cross_file_depth: 50,
        };
    }

    async run(context: GateContext): Promise<Failure[]> {
        const failures: Failure[] = [];
        const record = context.record;
        if (!record || !this.extendedConfig.enabled) return [];

        const files = await FileScanner.findFiles({ cwd: context.cwd });
        const envAnchors = record.anchors.filter(a => a.type === 'env' && a.confidence >= 1);

        // Collect all patterns across files for cross-file analysis
        const namingPatterns: Map<string, { casing: string; file: string; count: number }[]> = new Map();
        const importPatterns: Map<string, string[]> = new Map();

        for (const file of files) {
            try {
                const content = await fs.readFile(path.join(context.cwd, file), 'utf-8');

                // 1. Original: Detect Redundant Suffixes (The Golden Example)
                this.checkEnvDrift(content, file, envAnchors, failures);

                // 2. NEW: Cross-file pattern collection
                if (this.extendedConfig.cross_file_patterns) {
                    this.collectNamingPatterns(content, file, namingPatterns);
                    this.collectImportPatterns(content, file, importPatterns);
                }

            } catch (e) { }
        }

        // 3. NEW: Analyze naming consistency across files
        if (this.extendedConfig.naming_consistency) {
            this.analyzeNamingConsistency(namingPatterns, failures);
        }

        // 4. NEW: Analyze import relationship patterns
        if (this.extendedConfig.import_relationships) {
            this.analyzeImportPatterns(importPatterns, failures);
        }

        return failures;
    }

    private checkEnvDrift(content: string, file: string, anchors: any[], failures: Failure[]) {
        // Find all environment variable accesses in the content
        const matches = content.matchAll(/process\.env(?:\.([A-Z0-9_]+)|\[['"]([A-Z0-9_]+)['"]\])/g);

        for (const match of matches) {
            const accessedVar = match[1] || match[2];

            for (const anchor of anchors) {
                // If the accessed variable contains the anchor but is not equal to it, 
                // it's a potential "invented" redundancy (e.g. CORE_URL vs CORE_URL_PROD)
                if (accessedVar !== anchor.id && accessedVar.includes(anchor.id)) {
                    const deviation = accessedVar.replace(anchor.id, '').replace(/^_|_$/, '');

                    failures.push(this.createFailure(
                        `Context Drift: Redundant variation '${accessedVar}' detected in ${file}.`,
                        [file],
                        `The project already uses '${anchor.id}' as a standard anchor. Avoid inventing variations like '${deviation}'. Reuse the existing anchor or align with established project patterns.`
                    ));
                }
            }
        }
    }

    /**
     * Collect naming patterns (function names, class names, variable names)
     */
    private collectNamingPatterns(
        content: string,
        file: string,
        patterns: Map<string, { casing: string; file: string; count: number }[]>
    ) {
        // Named function declarations: function fetchData() { ... }
        const namedFuncMatches = content.matchAll(/function\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/g);
        for (const match of namedFuncMatches) {
            const casing = this.detectCasing(match[1]);
            this.addPattern(patterns, 'function', { casing, file, count: 1 });
        }

        // Arrow function expressions: (export) const fetchData = (async) (...) => { ... }
        const arrowFuncMatches = content.matchAll(/(?:export\s+)?(?:const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[a-zA-Z_$][a-zA-Z0-9_$]*)\s*=>/g);
        for (const match of arrowFuncMatches) {
            const casing = this.detectCasing(match[1]);
            this.addPattern(patterns, 'function', { casing, file, count: 1 });
        }

        // Function expressions: (export) const fetchData = (async) function(...) { ... }
        const funcExprMatches = content.matchAll(/(?:export\s+)?(?:const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=\s*(?:async\s+)?function\s*\(/g);
        for (const match of funcExprMatches) {
            const casing = this.detectCasing(match[1]);
            this.addPattern(patterns, 'function', { casing, file, count: 1 });
        }

        // Class declarations
        const classMatches = content.matchAll(/class\s+([A-Za-z_$][A-Za-z0-9_$]*)/g);
        for (const match of classMatches) {
            const casing = this.detectCasing(match[1]);
            this.addPattern(patterns, 'class', { casing, file, count: 1 });
        }

        // Interface declarations (TypeScript)
        const interfaceMatches = content.matchAll(/interface\s+([A-Za-z_$][A-Za-z0-9_$]*)/g);
        for (const match of interfaceMatches) {
            const casing = this.detectCasing(match[1]);
            this.addPattern(patterns, 'interface', { casing, file, count: 1 });
        }
    }

    /**
     * Collect import patterns
     */
    private collectImportPatterns(content: string, file: string, patterns: Map<string, string[]>) {
        // ES6 imports
        const importMatches = content.matchAll(/import\s+(?:{[^}]+}|\*\s+as\s+\w+|\w+)\s+from\s+['"]([^'"]+)['"]/g);
        for (const match of importMatches) {
            const importPath = match[1];
            if (!patterns.has(file)) {
                patterns.set(file, []);
            }
            patterns.get(file)!.push(importPath);
        }
    }

    /**
     * Analyze naming consistency across files
     */
    private analyzeNamingConsistency(
        patterns: Map<string, { casing: string; file: string; count: number }[]>,
        failures: Failure[]
    ) {
        for (const [type, entries] of patterns) {
            const casingCounts = new Map<string, number>();
            for (const entry of entries) {
                casingCounts.set(entry.casing, (casingCounts.get(entry.casing) || 0) + entry.count);
            }

            // Find dominant casing
            let dominant = '';
            let maxCount = 0;
            for (const [casing, count] of casingCounts) {
                if (count > maxCount) {
                    dominant = casing;
                    maxCount = count;
                }
            }

            // Report violations (non-dominant casing with significant usage)
            const total = entries.reduce((sum, e) => sum + e.count, 0);
            const threshold = total * (1 - (this.extendedConfig.sensitivity ?? 0.8));

            for (const [casing, count] of casingCounts) {
                if (casing !== dominant && count > threshold) {
                    const violatingFiles = entries.filter(e => e.casing === casing).map(e => e.file);
                    const uniqueFiles = [...new Set(violatingFiles)].slice(0, 5);

                    failures.push(this.createFailure(
                        `Cross-file naming inconsistency: ${type} names use ${casing} in ${count} places (dominant is ${dominant})`,
                        uniqueFiles,
                        `Standardize ${type} naming to ${dominant}. Found ${casing} in: ${uniqueFiles.join(', ')}`,
                        'Naming Convention Drift'
                    ));
                }
            }
        }
    }

    /**
     * Analyze import patterns for consistency
     */
    private analyzeImportPatterns(patterns: Map<string, string[]>, failures: Failure[]) {
        // Check for mixed import styles (relative vs absolute)
        const relativeCount = new Map<string, number>();
        const absoluteCount = new Map<string, number>();

        for (const [file, imports] of patterns) {
            for (const imp of imports) {
                if (imp.startsWith('.') || imp.startsWith('..')) {
                    relativeCount.set(file, (relativeCount.get(file) || 0) + 1);
                } else if (!imp.startsWith('@') && !imp.includes('/')) {
                    // Skip external packages
                } else {
                    absoluteCount.set(file, (absoluteCount.get(file) || 0) + 1);
                }
            }
        }

        // Detect files with both relative AND absolute local imports
        const mixedFiles: string[] = [];
        for (const file of patterns.keys()) {
            const hasRelative = (relativeCount.get(file) || 0) > 0;
            const hasAbsolute = (absoluteCount.get(file) || 0) > 0;
            if (hasRelative && hasAbsolute) {
                mixedFiles.push(file);
            }
        }

        if (mixedFiles.length > 3) {
            failures.push(this.createFailure(
                `Cross-file import inconsistency: ${mixedFiles.length} files mix relative and absolute imports`,
                mixedFiles.slice(0, 5),
                'Standardize import style across the codebase. Use either relative (./foo) or path aliases (@/foo) consistently.',
                'Import Pattern Drift'
            ));
        }
    }

    /**
     * Detect casing convention of an identifier
     */
    private detectCasing(name: string): string {
        if (/^[A-Z][a-z]/.test(name) && /[a-z][A-Z]/.test(name)) return 'PascalCase';
        if (/^[a-z]/.test(name) && /[a-z][A-Z]/.test(name)) return 'camelCase';
        if (/^[a-z][a-zA-Z0-9]*$/.test(name)) return 'camelCase';  // single-word lowercase (e.g. fetch, use, get)
        if (/^[a-z]+(_[a-z]+)+$/.test(name)) return 'snake_case';
        if (/^[A-Z]+(_[A-Z]+)*$/.test(name)) return 'SCREAMING_SNAKE';
        if (/^[A-Z][a-zA-Z]*$/.test(name)) return 'PascalCase';
        return 'unknown';
    }

    private addPattern(
        patterns: Map<string, { casing: string; file: string; count: number }[]>,
        type: string,
        entry: { casing: string; file: string; count: number }
    ) {
        if (!patterns.has(type)) {
            patterns.set(type, []);
        }
        patterns.get(type)!.push(entry);
    }
}
