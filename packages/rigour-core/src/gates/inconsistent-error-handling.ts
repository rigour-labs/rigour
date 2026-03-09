/**
 * Inconsistent Error Handling Gate
 *
 * Detects when the same error type is handled differently across the codebase.
 * This is an AI-specific failure mode — each agent session writes error handling
 * from scratch, leading to 4 different patterns for the same error type.
 *
 * Detection strategy:
 * 1. Extract all try-catch blocks and error handling patterns
 * 2. Cluster by caught error type (e.g. "Error", "TypeError", custom errors)
 * 3. Compare handling strategies within each cluster
 * 4. Flag types with >2 distinct handling patterns across files
 *
 * Examples of inconsistency:
 * - File A: catch(e) { console.log(e) }
 * - File B: catch(e) { throw new AppError(e) }
 * - File C: catch(e) { return null }
 * - File D: catch(e) { [empty] }
 *
 */

import { Gate, GateContext } from './base.js';
import { Failure, Provenance } from '../types/index.js';
import { FileScanner } from '../utils/scanner.js';
import { Logger } from '../utils/logger.js';
import { languageAdapters } from './language-adapters/index.js';
import fs from 'fs-extra';
import path from 'path';

interface ErrorHandler {
    file: string;
    line: number;
    errorType: string;       // What's caught: 'Error', 'TypeError', 'any', etc.
    strategy: string;        // Classified handling strategy
    rawPattern: string;      // First line of catch body for display
}

export interface InconsistentErrorHandlingConfig {
    enabled?: boolean;
    max_strategies_per_type?: number;  // Flag if more than N strategies, default 2
    min_occurrences?: number;          // Minimum catch blocks to analyze, default 3
    ignore_empty_catches?: boolean;    // Whether to count empty catches as a strategy
}

export class InconsistentErrorHandlingGate extends Gate {
    private config: Required<InconsistentErrorHandlingConfig>;

    constructor(config: InconsistentErrorHandlingConfig = {}) {
        super('inconsistent-error-handling', 'Inconsistent Error Handling Detection');
        this.config = {
            enabled: config.enabled ?? true,
            max_strategies_per_type: config.max_strategies_per_type ?? 2,
            min_occurrences: config.min_occurrences ?? 3,
            ignore_empty_catches: config.ignore_empty_catches ?? false,
        };
    }

    protected get provenance(): Provenance { return 'ai-drift'; }

    async run(context: GateContext): Promise<Failure[]> {
        if (!this.config.enabled) return [];

        const failures: Failure[] = [];
        const handlers: ErrorHandler[] = [];

        const scanPatterns = context.patterns || languageAdapters.getScanPatterns();
        const files = await FileScanner.findFiles({
            cwd: context.cwd,
            patterns: scanPatterns,
            ignore: [...(context.ignore || []), '**/node_modules/**', '**/dist/**', '**/*.test.*', '**/*.spec.*'],
        });

        Logger.info(`Inconsistent Error Handling: Scanning ${files.length} files`);

        const CONCURRENCY = 16;
        for (let i = 0; i < files.length; i += CONCURRENCY) {
            const batch = files.slice(i, i + CONCURRENCY);
            const results = await Promise.allSettled(batch.map(async (file) => {
                if (this.shouldSkipFile(file)) return [];
                const content = await fs.readFile(path.join(context.cwd, file), 'utf-8');
                const adapter = languageAdapters.getAdapter(file);
                if (!adapter) return [];

                const localHandlers: typeof handlers = [];
                const errorHandlerFacts = adapter.extractErrorHandlers(content);
                for (const fact of errorHandlerFacts) {
                    localHandlers.push({
                        file,
                        line: fact.startLine,
                        errorType: fact.type,
                        strategy: fact.strategy,
                        rawPattern: fact.body.split('\n')[0]?.trim() || '',
                    });
                }
                return localHandlers;
            }));
            for (const result of results) {
                if (result.status === 'fulfilled') handlers.push(...result.value);
            }
        }

        // Group by error type
        const byType = new Map<string, ErrorHandler[]>();
        for (const handler of handlers) {
            const existing = byType.get(handler.errorType) || [];
            existing.push(handler);
            byType.set(handler.errorType, existing);
        }

        // Analyze each error type for inconsistent handling
        for (const [errorType, typeHandlers] of byType) {
            if (typeHandlers.length < this.config.min_occurrences) continue;

            // Count unique strategies
            const strategies = new Map<string, ErrorHandler[]>();
            for (const handler of typeHandlers) {
                const existing = strategies.get(handler.strategy) || [];
                existing.push(handler);
                strategies.set(handler.strategy, existing);
            }

            // Filter out empty catches if configured
            const activeStrategies = this.config.ignore_empty_catches
                ? new Map([...strategies].filter(([k]) => k !== 'swallow'))
                : strategies;

            if (activeStrategies.size > this.config.max_strategies_per_type) {
                // Only flag if handlers span multiple files
                const uniqueFiles = new Set(typeHandlers.map(h => h.file));
                if (uniqueFiles.size < 2) continue;

                const strategyBreakdown = [...activeStrategies.entries()]
                    .map(([strategy, handlers]) => {
                        const files = [...new Set(handlers.map(h => h.file))].slice(0, 3);
                        return `  • ${strategy} (${handlers.length}x): ${files.join(', ')}`;
                    })
                    .join('\n');

                const severity = uniqueFiles.size >= 4 && activeStrategies.size >= 4 ? 'high' : 'medium';

                failures.push(this.createFailure(
                    `Inconsistent error handling for '${errorType}': ${activeStrategies.size} different strategies found across ${uniqueFiles.size} files:\n${strategyBreakdown}`,
                    [...uniqueFiles].slice(0, 5),
                    `Standardize error handling for '${errorType}'. Create a shared error handler or establish a project convention. AI agents often write error handling from scratch each session, leading to divergent patterns.`,
                    'Inconsistent Error Handling',
                    typeHandlers[0].line,
                    undefined,
                    severity
                ));
            }
        }

        return failures;
    }


    private shouldSkipFile(file: string): boolean {
        const normalized = file.replace(/\\/g, '/');
        return (
            normalized.includes('/examples/') ||
            normalized.includes('/src/gates/') ||
            normalized.endsWith('src/hooks/standalone-checker.ts') ||
            normalized.endsWith('packages/rigour-mcp/src/index.ts') ||
            normalized.endsWith('packages/rigour-studio/src/App.tsx')
        );
    }
}
