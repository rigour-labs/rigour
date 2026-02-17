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
 * @since v2.16.0
 */

import { Gate, GateContext } from './base.js';
import { Failure } from '../types/index.js';
import { FileScanner } from '../utils/scanner.js';
import { Logger } from '../utils/logger.js';
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

    async run(context: GateContext): Promise<Failure[]> {
        if (!this.config.enabled) return [];

        const failures: Failure[] = [];
        const handlers: ErrorHandler[] = [];

        const files = await FileScanner.findFiles({
            cwd: context.cwd,
            patterns: ['**/*.{ts,js,tsx,jsx}'],
            ignore: [...(context.ignore || []), '**/node_modules/**', '**/dist/**', '**/*.test.*', '**/*.spec.*'],
        });

        Logger.info(`Inconsistent Error Handling: Scanning ${files.length} files`);

        for (const file of files) {
            try {
                const content = await fs.readFile(path.join(context.cwd, file), 'utf-8');
                this.extractErrorHandlers(content, file, handlers);
            } catch (e) { }
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

                failures.push(this.createFailure(
                    `Inconsistent error handling for '${errorType}': ${activeStrategies.size} different strategies found across ${uniqueFiles.size} files:\n${strategyBreakdown}`,
                    [...uniqueFiles].slice(0, 5),
                    `Standardize error handling for '${errorType}'. Create a shared error handler or establish a project convention. AI agents often write error handling from scratch each session, leading to divergent patterns.`,
                    'Inconsistent Error Handling',
                    typeHandlers[0].line,
                    undefined,
                    'high'
                ));
            }
        }

        return failures;
    }

    private extractErrorHandlers(content: string, file: string, handlers: ErrorHandler[]): void {
        const lines = content.split('\n');

        for (let i = 0; i < lines.length; i++) {
            // Match catch clauses: catch (e), catch (error: Error), catch (e: TypeError)
            const catchMatch = lines[i].match(/\bcatch\s*\(\s*(\w+)(?:\s*:\s*(\w+))?\s*\)/);
            if (!catchMatch) continue;

            const varName = catchMatch[1];
            const explicitType = catchMatch[2] || 'any';

            // Extract catch body (up to next closing brace at same level)
            const body = this.extractCatchBody(lines, i);
            if (!body) continue;

            const strategy = this.classifyStrategy(body, varName);
            const rawPattern = body.split('\n')[0]?.trim() || '';

            handlers.push({
                file,
                line: i + 1,
                errorType: explicitType,
                strategy,
                rawPattern,
            });
        }

        // Also detect .catch() promise patterns
        for (let i = 0; i < lines.length; i++) {
            const catchMatch = lines[i].match(/\.catch\s*\(\s*(?:async\s+)?(?:\(\s*)?(\w+)/);
            if (!catchMatch) continue;

            const varName = catchMatch[1];

            // Extract the callback body
            const body = this.extractCatchCallbackBody(lines, i);
            if (!body) continue;

            const strategy = this.classifyStrategy(body, varName);

            handlers.push({
                file,
                line: i + 1,
                errorType: 'Promise',
                strategy,
                rawPattern: body.split('\n')[0]?.trim() || '',
            });
        }
    }

    private classifyStrategy(body: string, varName: string): string {
        const trimmed = body.trim();

        // Empty catch (swallow)
        if (!trimmed || trimmed === '{}' || trimmed === '') {
            return 'swallow';
        }

        // Re-throw
        if (/\bthrow\b/.test(trimmed)) {
            if (/\bthrow\s+new\b/.test(trimmed)) return 'wrap-and-throw';
            if (new RegExp(`\\bthrow\\s+${varName}\\b`).test(trimmed)) return 'rethrow';
            return 'throw-new';
        }

        // Return patterns
        if (/\breturn\s+null\b/.test(trimmed)) return 'return-null';
        if (/\breturn\s+undefined\b/.test(trimmed) || /\breturn\s*;/.test(trimmed)) return 'return-undefined';
        if (/\breturn\s+\[\s*\]/.test(trimmed)) return 'return-empty-array';
        if (/\breturn\s+\{\s*\}/.test(trimmed)) return 'return-empty-object';
        if (/\breturn\s+false\b/.test(trimmed)) return 'return-false';
        if (/\breturn\s+/.test(trimmed)) return 'return-value';

        // Logging patterns
        if (/console\.(error|warn)\b/.test(trimmed)) return 'log-error';
        if (/console\.log\b/.test(trimmed)) return 'log-info';
        if (/\blogger\b/i.test(trimmed) || /\blog\b/i.test(trimmed)) return 'log-custom';

        // Process.exit
        if (/process\.exit\b/.test(trimmed)) return 'exit';

        // Response patterns (Express/HTTP)
        if (/\bres\s*\.\s*status\b/.test(trimmed) || /\bres\s*\.\s*json\b/.test(trimmed)) return 'http-response';

        // Notification patterns
        if (/\bnotif|toast|alert|modal\b/i.test(trimmed)) return 'user-notification';

        return 'other';
    }

    private extractCatchBody(lines: string[], catchLine: number): string | null {
        let braceDepth = 0;
        let started = false;
        const body: string[] = [];

        for (let i = catchLine; i < lines.length; i++) {
            for (const ch of lines[i]) {
                if (ch === '{') { braceDepth++; started = true; }
                if (ch === '}') braceDepth--;
            }
            if (started && i > catchLine) body.push(lines[i]);
            if (started && braceDepth === 0) break;
        }

        return body.length > 0 ? body.join('\n') : null;
    }

    private extractCatchCallbackBody(lines: string[], startLine: number): string | null {
        let depth = 0;
        let started = false;
        const body: string[] = [];

        for (let i = startLine; i < Math.min(startLine + 20, lines.length); i++) {
            for (const ch of lines[i]) {
                if (ch === '{' || ch === '(') { depth++; started = true; }
                if (ch === '}' || ch === ')') depth--;
            }
            if (started && i > startLine) body.push(lines[i]);
            if (started && depth <= 0) break;
        }

        return body.length > 0 ? body.join('\n') : null;
    }
}
