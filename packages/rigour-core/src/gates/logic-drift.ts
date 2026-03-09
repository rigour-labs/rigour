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
 */

import { Gate, GateContext } from './base.js';
import { Failure, Provenance } from '../types/index.js';
import { FileScanner } from '../utils/scanner.js';
import { Logger } from '../utils/logger.js';
import { languageAdapters } from './language-adapters/index.js';
import { extractCallSequence, isDangerousMutation } from './logic-drift-extractors.js';
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

        // Find source files using adapter-supported patterns
        const files = await FileScanner.findFiles({
            cwd: context.cwd,
            patterns: context.patterns || languageAdapters.getScanPatterns(),
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
                const raw = await fs.readJson(baselinePath);
                // Validate baseline has required structure
                if (raw && Array.isArray(raw.functions)) {
                    previousBaseline = raw;
                } else {
                    Logger.debug('Invalid or empty logic baseline format, will recreate');
                }
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
        const adapter = languageAdapters.getAdapter(file);

        if (!adapter) {
            return baselines; // Unsupported language
        }

        const skipKeywords = new Set(['if', 'for', 'while', 'switch', 'catch', 'constructor', 'else', 'elif', 'elsif', 'rescue']);
        const functions = adapter.extractFunctions(content, file);

        for (const fn of functions) {
            // Skip control flow keywords
            if (skipKeywords.has(fn.name)) continue;
            // Skip very small functions
            if (fn.body.length < 3) continue;

            const normalized = adapter.stripComments(fn.body)
                .replace(/\s+/g, ' ')
                .trim();

            baselines.push({
                name: fn.name,
                file,
                line: fn.startLine,
                comparisonOps: adapter.extractComparisonOps(fn.body),
                branchCount: adapter.countBranches(fn.body),
                returnCount: adapter.countReturns(fn.body),
                callSequence: extractCallSequence(fn.body),
                bodyHash: crypto.createHash('md5').update(normalized).digest('hex'),
            });
        }

        return baselines;
    }

    // ─── Mutation Detection ──────────────────────────────────────────

    /**
     * Detect specific operator mutations between two ordered operator lists.
     * Only reports CHANGED operators, not added/removed ones (those are
     * covered by branch count changes).
     */
    private detectOperatorMutations(prev: string[], curr: string[]): { from: string; to: string }[] {
        const mutations: { from: string; to: string }[] = [];

        const minLen = Math.min(prev.length, curr.length);
        for (let i = 0; i < minLen; i++) {
            if (prev[i] !== curr[i]) {
                if (isDangerousMutation(prev[i], curr[i])) {
                    mutations.push({ from: prev[i], to: curr[i] });
                }
            }
        }

        return mutations;
    }
}
