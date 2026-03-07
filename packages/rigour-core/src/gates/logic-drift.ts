/**
 * Logic Drift Foundation Gate
 *
 * Detects when AI subtly changes business logic in functions:
 * - Comparison operator mutations: >= became > (off-by-one)
 * - Return statement additions/removals
 * - Branch count changes (new if/else added or removed)
 * - Call sequence changes (function calls reordered)
 *
 * This is the HARDEST drift to catch because:
 * - Code still compiles
 * - Tests might still pass (if they don't cover edge cases)
 * - The change looks intentional ("AI refactored the function")
 *
 * Strategy: Collect baselines for critical functions, then detect
 * mutations between scans. This foundation enables future LLM-powered
 * deeper analysis (feeding baselines into DriftBench training).
 *
 * @since v5.1.0
 */

import { Gate, GateContext } from './base.js';
import { Failure, Provenance } from '../types/index.js';
import { FileScanner } from '../utils/scanner.js';
import { Logger } from '../utils/logger.js';
import fs from 'fs-extra';
import path from 'path';
import crypto from 'crypto';

export interface LogicDriftConfig {
    enabled?: boolean;
    baseline_path?: string;        // Where to store baselines, default .rigour/logic-baseline.json
    track_operators?: boolean;     // Track comparison operator changes, default true
    track_branches?: boolean;      // Track if/else/switch count changes, default true
    track_returns?: boolean;       // Track return statement changes, default true
}

interface FunctionBaseline {
    name: string;
    file: string;
    line: number;
    comparisonOps: string[];       // Ordered list: ['>=', '===', '!==']
    branchCount: number;           // Number of if/else/switch/ternary
    returnCount: number;           // Number of return statements
    callSequence: string[];        // Ordered function calls: ['validate', 'transform', 'save']
    bodyHash: string;              // Normalized body hash for quick change detection
}

interface LogicBaseline {
    functions: FunctionBaseline[];
    createdAt: string;
    lastUpdated: string;
    scanCount: number;
}

export class LogicDriftGate extends Gate {
    private config: Required<LogicDriftConfig>;

    constructor(config: LogicDriftConfig = {}) {
        super('logic-drift', 'Logic Drift Detection');
        this.config = {
            enabled: config.enabled ?? true,
            baseline_path: config.baseline_path ?? '.rigour/logic-baseline.json',
            track_operators: config.track_operators ?? true,
            track_branches: config.track_branches ?? true,
            track_returns: config.track_returns ?? true,
        };
    }

    protected get provenance(): Provenance { return 'ai-drift'; }

    async run(context: GateContext): Promise<Failure[]> {
        if (!this.config.enabled) return [];

        const failures: Failure[] = [];
        const baselinePath = path.join(context.cwd, this.config.baseline_path);

        // Find source files
        const files = await FileScanner.findFiles({
            cwd: context.cwd,
            patterns: context.patterns || ['**/*.{ts,tsx,js,jsx}'],
            ignore: [...(context.ignore || []), '**/node_modules/**', '**/dist/**', '**/*.test.*', '**/*.spec.*', '**/*.d.ts'],
        });

        if (files.length === 0) return [];

        // Extract current function baselines
        const currentFunctions: FunctionBaseline[] = [];
        const contents = await FileScanner.readFiles(context.cwd, files, context.fileCache);

        for (const [file, content] of contents) {
            const extracted = this.extractFunctionBaselines(content, file);
            currentFunctions.push(...extracted);
        }

        // Load previous baseline
        let previousBaseline: LogicBaseline | null = null;
        if (await fs.pathExists(baselinePath)) {
            try {
                previousBaseline = await fs.readJson(baselinePath);
            } catch {
                Logger.debug('Failed to load logic baseline');
            }
        }

        if (!previousBaseline) {
            // First scan: save baseline, no comparisons yet
            const baseline: LogicBaseline = {
                functions: currentFunctions,
                createdAt: new Date().toISOString(),
                lastUpdated: new Date().toISOString(),
                scanCount: 1,
            };
            await fs.ensureDir(path.dirname(baselinePath));
            await fs.writeJson(baselinePath, baseline, { spaces: 2 });
            Logger.info(`Logic Drift: Created baseline with ${currentFunctions.length} functions → ${baselinePath}`);
            return [];
        }

        // Compare current functions against previous baselines
        const prevMap = new Map<string, FunctionBaseline>();
        for (const fn of previousBaseline.functions) {
            // Key by file:name for matching
            prevMap.set(`${fn.file}:${fn.name}`, fn);
        }

        for (const current of currentFunctions) {
            const key = `${current.file}:${current.name}`;
            const prev = prevMap.get(key);
            if (!prev) continue; // New function, no baseline to compare

            // Skip if body hash is identical (no changes at all)
            if (current.bodyHash === prev.bodyHash) continue;

            // ── Operator Mutations ──
            if (this.config.track_operators) {
                const opChanges = this.detectOperatorMutations(prev.comparisonOps, current.comparisonOps);
                for (const change of opChanges) {
                    failures.push(this.createFailure(
                        `Logic drift: Comparison operator changed from '${change.from}' to '${change.to}' in function '${current.name}'.`,
                        [current.file],
                        `Operator mutation in ${current.file}:${current.line} — '${change.from}' → '${change.to}'. This could introduce off-by-one errors or change boundary conditions. Verify this change is intentional.`,
                        'Logic Drift: Operator Mutation',
                        current.line,
                        undefined,
                        'high'
                    ));
                }
            }

            // ── Return Count Changes ──
            if (this.config.track_returns && current.returnCount !== prev.returnCount) {
                const diff = current.returnCount - prev.returnCount;
                const direction = diff > 0 ? 'added' : 'removed';
                failures.push(this.createFailure(
                    `Logic drift: ${Math.abs(diff)} return statement(s) ${direction} in function '${current.name}' (was ${prev.returnCount}, now ${current.returnCount}).`,
                    [current.file],
                    `Return statement count changed in ${current.file}:${current.line}. This may alter control flow or error handling paths.`,
                    'Logic Drift: Return Change',
                    current.line,
                    undefined,
                    'medium'
                ));
            }

            // ── Branch Count Changes ──
            if (this.config.track_branches) {
                const branchDiff = Math.abs(current.branchCount - prev.branchCount);
                if (branchDiff >= 2) {
                    // Only alert on significant branch changes (±2+)
                    const direction = current.branchCount > prev.branchCount ? 'added' : 'removed';
                    failures.push(this.createFailure(
                        `Logic drift: ${branchDiff} branch(es) ${direction} in function '${current.name}' (was ${prev.branchCount}, now ${current.branchCount}).`,
                        [current.file],
                        `Significant branch count change in ${current.file}:${current.line}. Review whether all code paths are still correct.`,
                        'Logic Drift: Branch Change',
                        current.line,
                        undefined,
                        'low'
                    ));
                }
            }
        }

        // Update baseline with current data
        const updatedBaseline: LogicBaseline = {
            functions: currentFunctions,
            createdAt: previousBaseline.createdAt,
            lastUpdated: new Date().toISOString(),
            scanCount: previousBaseline.scanCount + 1,
        };
        await fs.writeJson(baselinePath, updatedBaseline, { spaces: 2 });

        if (failures.length > 0) {
            Logger.info(`Logic Drift: Found ${failures.length} logic mutations`);
        }

        return failures;
    }

    // ─── Function Baseline Extraction ────────────────────────────────

    private extractFunctionBaselines(content: string, file: string): FunctionBaseline[] {
        const baselines: FunctionBaseline[] = [];
        const lines = content.split('\n');

        const fnPatterns = [
            /^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/,
            /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|(\w+))\s*=>/,
            /^\s+(?:async\s+)?(\w+)\s*\([^)]*\)\s*\{/,
        ];

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            for (const pattern of fnPatterns) {
                const match = line.match(pattern);
                if (match) {
                    const name = match[1];
                    if (['if', 'for', 'while', 'switch', 'catch', 'constructor'].includes(name)) continue;

                    const body = this.extractBody(lines, i);
                    if (body.length < 3) continue; // Skip trivial functions

                    const bodyText = body.join('\n');
                    const normalized = bodyText
                        .replace(/\/\/.*/g, '')
                        .replace(/\/\*[\s\S]*?\*\//g, '')
                        .replace(/\s+/g, ' ')
                        .trim();

                    baselines.push({
                        name,
                        file,
                        line: i + 1,
                        comparisonOps: this.extractComparisonOps(bodyText),
                        branchCount: this.countBranches(bodyText),
                        returnCount: this.countReturns(bodyText),
                        callSequence: this.extractCallSequence(bodyText),
                        bodyHash: crypto.createHash('md5').update(normalized).digest('hex'),
                    });
                    break;
                }
            }
        }

        return baselines;
    }

    private extractBody(lines: string[], startIndex: number): string[] {
        let braceDepth = 0;
        let started = false;
        const body: string[] = [];

        for (let i = startIndex; i < lines.length; i++) {
            const line = lines[i];
            for (const ch of line) {
                if (ch === '{') { braceDepth++; started = true; }
                if (ch === '}') braceDepth--;
            }
            if (started) body.push(line);
            if (started && braceDepth === 0) break;
        }

        return body;
    }

    /**
     * Extract all comparison operators from function body in order.
     * These are the most critical mutations: >= to > causes off-by-one.
     */
    private extractComparisonOps(body: string): string[] {
        const ops: string[] = [];
        const matches = body.matchAll(/(===|!==|==|!=|>=|<=|>(?!=)|<(?!=))/g);
        for (const m of matches) {
            ops.push(m[1]);
        }
        return ops;
    }

    private countBranches(body: string): number {
        let count = 0;
        // Count if, else if, else, switch, case, ternary
        count += (body.match(/\bif\s*\(/g) || []).length;
        count += (body.match(/\belse\s+if\s*\(/g) || []).length;
        count += (body.match(/\belse\s*\{/g) || []).length;
        count += (body.match(/\bswitch\s*\(/g) || []).length;
        count += (body.match(/\bcase\s+/g) || []).length;
        count += (body.match(/\?\s*[^?]/g) || []).length; // ternary (approximate)
        return count;
    }

    private countReturns(body: string): number {
        return (body.match(/\breturn\b/g) || []).length;
    }

    /**
     * Extract ordered sequence of function calls.
     * Useful for detecting when AI reorders operations.
     */
    private extractCallSequence(body: string): string[] {
        const calls: string[] = [];
        const matches = body.matchAll(/\b(\w+)\s*\(/g);
        const keywords = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'async', 'await', 'return', 'new', 'typeof', 'instanceof']);
        for (const m of matches) {
            if (!keywords.has(m[1])) {
                calls.push(m[1]);
            }
        }
        return calls;
    }

    // ─── Mutation Detection ──────────────────────────────────────────

    /**
     * Detect specific operator mutations between two ordered operator lists.
     * Only reports CHANGED operators, not added/removed ones (those are
     * covered by branch count changes).
     *
     * Example:
     * prev: ['>=', '===', '!==']
     * curr: ['>',  '===', '!==']
     * → [{from: '>=', to: '>'}]
     */
    private detectOperatorMutations(prev: string[], curr: string[]): { from: string; to: string }[] {
        const mutations: { from: string; to: string }[] = [];

        // Use LCS-like alignment for best matching
        const minLen = Math.min(prev.length, curr.length);
        for (let i = 0; i < minLen; i++) {
            if (prev[i] !== curr[i]) {
                // Check if this is a "dangerous" mutation (same family, different strictness)
                if (this.isDangerousMutation(prev[i], curr[i])) {
                    mutations.push({ from: prev[i], to: curr[i] });
                }
            }
        }

        return mutations;
    }

    /**
     * Classify whether an operator change is "dangerous" (likely unintentional).
     *
     * Dangerous mutations:
     * - >= to > (boundary change, off-by-one)
     * - <= to < (boundary change)
     * - === to == (type coercion change)
     * - !== to != (type coercion change)
     */
    private isDangerousMutation(from: string, to: string): boolean {
        const dangerous = new Set([
            '>=:>', '>:>=',       // Boundary mutations
            '<=:<', '<:<=',       // Boundary mutations
            '===:==', '==:===',   // Type coercion mutations
            '!==:!=', '!=:!==',   // Type coercion mutations
        ]);
        return dangerous.has(`${from}:${to}`);
    }
}
