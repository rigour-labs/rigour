/**
 * Context Window Artifacts Gate
 *
 * Detects quality degradation patterns within a single file that emerge
 * when AI loses context mid-generation. The telltale sign: clean,
 * well-structured code at the top of a file that gradually degrades
 * toward the bottom.
 *
 * Detection signals:
 * 1. Comment density drops sharply (top half vs bottom half)
 * 2. Function complexity increases toward end of file
 * 3. Variable naming quality degrades (shorter names, more single-letter vars)
 * 4. Error handling becomes sparser toward the bottom
 * 5. Code style inconsistencies emerge (indentation, spacing)
 *
 */

import { Gate, GateContext } from './base.js';
import { Failure, Provenance } from '../types/index.js';
import { FileScanner } from '../utils/scanner.js';
import { Logger } from '../utils/logger.js';
import { languageAdapters } from './language-adapters/index.js';
import fs from 'fs-extra';
import path from 'path';

interface FileQualityMetrics {
    file: string;
    totalLines: number;
    topHalf: HalfMetrics;
    bottomHalf: HalfMetrics;
    degradationScore: number;  // 0-1, higher = more degradation
    signals: string[];
}

interface HalfMetrics {
    commentDensity: number;         // comments per code line
    avgFunctionLength: number;      // average lines per function
    singleCharVarCount: number;     // number of single-char variables
    errorHandlingDensity: number;   // try/catch per function
    emptyBlockCount: number;        // empty {} blocks
    todoCount: number;              // TODO/FIXME/HACK comments
    avgIdentifierLength: number;    // average variable/function name length
}

export interface ContextWindowArtifactsConfig {
    enabled?: boolean;
    min_file_lines?: number;           // Only analyze files with 100+ lines
    degradation_threshold?: number;    // 0-1, flag if degradation > this, default 0.4
    signals_required?: number;         // How many signals needed to flag, default 2
}

export class ContextWindowArtifactsGate extends Gate {
    private config: Required<ContextWindowArtifactsConfig>;

    constructor(config: ContextWindowArtifactsConfig = {}) {
        super('context-window-artifacts', 'Context Window Artifact Detection');
        this.config = {
            enabled: config.enabled ?? true,
            min_file_lines: config.min_file_lines ?? 180,
            degradation_threshold: config.degradation_threshold ?? 0.55,
            signals_required: config.signals_required ?? 4,
        };
    }

    protected get provenance(): Provenance { return 'ai-drift'; }

    async run(context: GateContext): Promise<Failure[]> {
        if (!this.config.enabled) return [];

        const failures: Failure[] = [];

        const scanPatterns = context.patterns || languageAdapters.getScanPatterns();
        const files = await FileScanner.findFiles({
            cwd: context.cwd,
            patterns: scanPatterns,
            ignore: [...(context.ignore || []), '**/node_modules/**', '**/dist/**', '**/*.test.*', '**/*.spec.*', '**/*.min.*'],
        });

        Logger.info(`Context Window Artifacts: Scanning ${files.length} files`);

        for (const file of files) {
            if (this.shouldSkipFile(file)) continue;
            try {
                const content = await fs.readFile(path.join(context.cwd, file), 'utf-8');
                const lines = content.split('\n');

                if (lines.length < this.config.min_file_lines) continue;

                const metrics = this.analyzeFile(content, file, path.join(context.cwd, file));
                if (metrics && metrics.signals.length >= this.config.signals_required &&
                    metrics.degradationScore >= this.config.degradation_threshold) {

                    const signalList = metrics.signals.map(s => `  • ${s}`).join('\n');
                    const midpoint = Math.floor(metrics.totalLines / 2);

                    failures.push(this.createFailure(
                        `Context window artifact detected in ${file} (${metrics.totalLines} lines, degradation: ${(metrics.degradationScore * 100).toFixed(0)}%):\n${signalList}`,
                        [file],
                        `This file shows quality degradation from top to bottom, a pattern typical of AI context window exhaustion. Consider refactoring the bottom half or splitting the file. The quality drop begins around line ${midpoint}.`,
                        'Context Window Artifacts',
                        midpoint,
                        undefined,
                        'high'
                    ));
                }
            } catch (e) { }
        }

        return failures;
    }

    private shouldSkipFile(file: string): boolean {
        const normalized = file.replace(/\\/g, '/');
        return (
            normalized.includes('/examples/') ||
            normalized.includes('/src/gates/')
        );
    }

    private analyzeFile(content: string, file: string, fullPath: string): FileQualityMetrics | null {
        const lines = content.split('\n');
        const midpoint = Math.floor(lines.length / 2);

        const topContent = lines.slice(0, midpoint).join('\n');
        const bottomContent = lines.slice(midpoint).join('\n');

        const topMetrics = this.measureHalf(topContent, fullPath);
        const bottomMetrics = this.measureHalf(bottomContent, fullPath);

        const signals: string[] = [];
        let degradationScore = 0;

        // Signal 1: Comment density drops (use threshold to avoid tiny-denominator noise)
        if (topMetrics.commentDensity > 0.01) {
            const commentRatio = bottomMetrics.commentDensity / topMetrics.commentDensity;
            if (commentRatio < 0.5) {
                signals.push(`Comment density drops ${((1 - commentRatio) * 100).toFixed(0)}% in bottom half`);
                degradationScore += 0.25;
            }
        }

        // Signal 2: Function length increases
        if (topMetrics.avgFunctionLength > 0 && bottomMetrics.avgFunctionLength > 0) {
            const lengthRatio = bottomMetrics.avgFunctionLength / topMetrics.avgFunctionLength;
            if (lengthRatio > 1.5) {
                signals.push(`Average function length ${lengthRatio.toFixed(1)}x longer in bottom half`);
                degradationScore += 0.2;
            }
        }

        // Signal 3: Variable naming quality degrades
        if (bottomMetrics.singleCharVarCount > topMetrics.singleCharVarCount * 2 &&
            bottomMetrics.singleCharVarCount >= 3) {
            signals.push(`${bottomMetrics.singleCharVarCount} single-char variables in bottom half vs ${topMetrics.singleCharVarCount} in top`);
            degradationScore += 0.2;
        }

        // Signal 3b: Average identifier length shrinks
        if (topMetrics.avgIdentifierLength > 0 && bottomMetrics.avgIdentifierLength > 0) {
            const nameRatio = bottomMetrics.avgIdentifierLength / topMetrics.avgIdentifierLength;
            if (nameRatio < 0.7) {
                signals.push(`Identifier names ${((1 - nameRatio) * 100).toFixed(0)}% shorter in bottom half`);
                degradationScore += 0.15;
            }
        }

        // Signal 4: Error handling becomes sparser
        if (topMetrics.errorHandlingDensity > 0) {
            const errorRatio = bottomMetrics.errorHandlingDensity / topMetrics.errorHandlingDensity;
            if (errorRatio < 0.3) {
                signals.push(`Error handling ${((1 - errorRatio) * 100).toFixed(0)}% less frequent in bottom half`);
                degradationScore += 0.2;
            }
        }

        // Signal 5: Empty blocks increase
        if (bottomMetrics.emptyBlockCount > topMetrics.emptyBlockCount + 2) {
            signals.push(`${bottomMetrics.emptyBlockCount} empty blocks in bottom half vs ${topMetrics.emptyBlockCount} in top`);
            degradationScore += 0.15;
        }

        // Signal 6: TODO/FIXME/HACK density increases at bottom
        if (bottomMetrics.todoCount > topMetrics.todoCount + 1) {
            signals.push(`${bottomMetrics.todoCount} TODO/FIXME/HACK in bottom half vs ${topMetrics.todoCount} in top`);
            degradationScore += 0.1;
        }

        // Cap at 1.0
        degradationScore = Math.min(1.0, degradationScore);

        return {
            file,
            totalLines: lines.length,
            topHalf: topMetrics,
            bottomHalf: bottomMetrics,
            degradationScore,
            signals,
        };
    }

    private measureHalf(content: string, fullPath: string): HalfMetrics {
        const adapter = languageAdapters.getAdapter(fullPath);
        const lines = content.split('\n');

        // Strip comments using adapter if available, otherwise fallback
        const codeWithoutComments = adapter ? adapter.stripComments(content) : content;
        const codeLines = codeWithoutComments.split('\n').filter(l => l.trim());

        // Count inline comments (// for C-style, # for Python/Ruby)
        // Exclude JSDoc/block comments (/** ... */ or * ...) which cluster at top unfairly
        const commentLines = lines.filter(l => {
            const trimmed = l.trim();
            return trimmed.startsWith('//') || trimmed.startsWith('#');
        });

        // Comment density
        const commentDensity = codeLines.length > 0 ? commentLines.length / codeLines.length : 0;

        // Function lengths using adapter if available
        const funcLengths = adapter
            ? this.measureFunctionLengthsFromAdapter(content, adapter)
            : this.measureFunctionLengthsLegacy(content);
        const avgFunctionLength = funcLengths.length > 0
            ? funcLengths.reduce((a, b) => a + b, 0) / funcLengths.length
            : 0;

        // Single-char variables — using naming patterns from adapter if available
        const singleCharVarCount = adapter
            ? this.countSingleCharVariablesFromAdapter(adapter, content)
            : this.countSingleCharVariablesLegacy(content);

        // Error handling density — use adapter if available
        const errorHandlers = adapter ? adapter.extractErrorHandlers(content) : [];
        const totalErrHandling = errorHandlers.length;
        const funcCount = Math.max(1, funcLengths.length);
        const errorHandlingDensity = totalErrHandling / funcCount;

        // Empty blocks
        const emptyBlockCount = (content.match(/\{\s*\}/g) || []).length;

        // TODO/FIXME/HACK count
        const todoCount = (content.match(/\b(TODO|FIXME|HACK|XXX)\b/gi) || []).length;

        // Average identifier length using naming patterns from adapter if available
        const avgIdentifierLength = adapter
            ? this.getAvgIdentifierLengthFromAdapter(adapter, content)
            : this.getAvgIdentifierLengthLegacy(content);

        return {
            commentDensity,
            avgFunctionLength,
            singleCharVarCount,
            errorHandlingDensity,
            emptyBlockCount,
            todoCount,
            avgIdentifierLength,
        };
    }

    private measureFunctionLengthsFromAdapter(content: string, adapter: ReturnType<typeof languageAdapters.getAdapter>): number[] {
        if (!adapter) return [];
        const functions = adapter.extractFunctions(content);
        return functions.map(func => func.endLine - func.startLine + 1);
    }

    private countSingleCharVariablesFromAdapter(adapter: ReturnType<typeof languageAdapters.getAdapter>, content: string): number {
        if (!adapter) return 0;
        const patterns = adapter.extractNamingPatterns(content);
        return patterns.filter(p => p.name.length === 1 && p.kind === 'variable').length;
    }

    private getAvgIdentifierLengthFromAdapter(adapter: ReturnType<typeof languageAdapters.getAdapter>, content: string): number {
        if (!adapter) return 0;
        const patterns = adapter.extractNamingPatterns(content);
        if (patterns.length === 0) return 0;
        const totalLength = patterns.reduce((sum, p) => sum + p.name.length, 0);
        return totalLength / patterns.length;
    }

    private measureFunctionLengthsLegacy(content: string): number[] {
        const lines = content.split('\n');
        const lengths: number[] = [];

        // Brace-based function patterns (JS/TS, Go, Rust, Java, Kotlin, C#)
        const bracePatterns = [
            /^(?:export\s+)?(?:async\s+)?function\s+\w+/,
            /^(?:export\s+)?(?:const|let|var)\s+\w+\s*=\s*(?:async\s+)?(?:\([^)]*\)|\w+)\s*=>/,
            /^\s+(?:async\s+)?\w+\s*\([^)]*\)\s*\{/,
            /^func\s+/,              // Go
            /^\s*(?:pub\s+)?(?:async\s+)?fn\s+/, // Rust
            /^\s*(?:public|private|protected|internal|static|override)\s+.*\w+\s*\(/, // Java/C#/Kotlin
        ];

        // Indent-based function patterns (Python, Ruby)
        const indentPatterns = [
            /^\s*(?:async\s+)?def\s+\w+/,   // Python/Ruby
        ];

        for (let i = 0; i < lines.length; i++) {
            // Try brace-based languages first
            let matched = false;
            for (const pattern of bracePatterns) {
                if (pattern.test(lines[i])) {
                    let braceDepth = 0;
                    let started = false;
                    let bodyLines = 0;

                    for (let j = i; j < lines.length; j++) {
                        for (const ch of lines[j]) {
                            if (ch === '{') { braceDepth++; started = true; }
                            if (ch === '}') braceDepth--;
                        }
                        if (started) bodyLines++;
                        if (started && braceDepth === 0) break;
                    }

                    if (bodyLines > 0) lengths.push(bodyLines);
                    matched = true;
                    break;
                }
            }
            if (matched) continue;

            // Try indent-based languages
            for (const pattern of indentPatterns) {
                if (pattern.test(lines[i])) {
                    const indent = lines[i].match(/^(\s*)/)?.[1]?.length || 0;
                    let bodyLines = 0;
                    for (let j = i + 1; j < lines.length; j++) {
                        if (lines[j].trim() === '') { bodyLines++; continue; }
                        const curIndent = lines[j].match(/^(\s*)/)?.[1]?.length || 0;
                        if (curIndent <= indent) break;
                        bodyLines++;
                    }
                    if (bodyLines > 0) lengths.push(bodyLines);
                    break;
                }
            }
        }

        return lengths;
    }

    private countSingleCharVariablesLegacy(content: string): number {
        const singleCharPatternsJS = content.match(/\b(?:const|let|var)\s+([a-z])\b/g) || [];
        const singleCharPatternsPy = content.match(/^\s*([a-z])\s*=/gm) || [];
        const singleCharPatternsGo = content.match(/\b(\w)\s*:=/g) || [];
        return singleCharPatternsJS.length + singleCharPatternsPy.length + singleCharPatternsGo.length;
    }

    private getAvgIdentifierLengthLegacy(content: string): number {
        const identPatternsJS = content.match(/\b(?:const|let|var|function)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/g) || [];
        const identPatternsPy = content.match(/\bdef\s+([a-zA-Z_]\w*)/g) || [];
        const identPatternsGo = content.match(/\bfunc\s+(?:\([^)]+\)\s+)?([a-zA-Z_]\w*)/g) || [];
        const identPatternsRs = content.match(/\bfn\s+([a-zA-Z_]\w*)/g) || [];
        const identPatternsRb = content.match(/\bdef\s+(?:self\.)?([a-zA-Z_]\w*)/g) || [];
        const allIdents = [...identPatternsJS, ...identPatternsPy, ...identPatternsGo, ...identPatternsRs, ...identPatternsRb];
        const identNames = allIdents.map(m => {
            const parts = m.split(/\s+/);
            return parts[parts.length - 1];
        });
        return identNames.length > 0
            ? identNames.reduce((sum, n) => sum + n.length, 0) / identNames.length
            : 0;
    }

}
