/**
 * Style Drift Detection Gate
 *
 * Detects when AI-generated code gradually drifts away from the project's
 * established coding conventions. AI models tend to use their own "default"
 * style which may differ from the project norm.
 *
 * What it checks:
 * 1. Naming conventions — camelCase vs snake_case vs PascalCase consistency
 * 2. Error handling patterns — try-catch vs .catch() vs Result type consistency
 * 3. Import style — named vs default vs wildcard import consistency
 * 4. Quote style — single vs double quote consistency
 *
 * How it works:
 * 1. First scan: sample source files → compute a style fingerprint → store baseline
 * 2. Subsequent scans: compare new/changed files against baseline
 * 3. If a file deviates >25% on any dimension → flag as style drift
 *
 * The baseline is stored in .rigour/style-baseline.json and evolves with
 * human-approved changes (not AI drift).
 *
 * @since v5.0.0
 */

import { Gate, GateContext } from './base.js';
import { Failure, Provenance } from '../types/index.js';
import { FileScanner } from '../utils/scanner.js';
import { Logger } from '../utils/logger.js';
import fs from 'fs-extra';
import path from 'path';

export interface StyleDriftConfig {
    enabled?: boolean;
    deviation_threshold?: number;  // 0-1, default 0.25 (25% deviation triggers alert)
    sample_size?: number;          // Max files to sample for baseline, default 100
    baseline_path?: string;        // Where to store baseline, default .rigour/style-baseline.json
}

interface CasingDistribution {
    camelCase: number;
    snake_case: number;
    PascalCase: number;
    SCREAMING_SNAKE: number;
}

interface StyleFingerprint {
    naming: {
        functions: CasingDistribution;
        variables: CasingDistribution;
    };
    errorHandling: {
        tryCatch: number;
        promiseCatch: number;
        resultType: number;
    };
    importStyle: {
        named: number;
        default: number;
        wildcard: number;
        sideEffect: number;
    };
    quoteStyle: {
        single: number;
        double: number;
        backtick: number;
    };
    totalFilesAnalyzed: number;
    createdAt: string;
}

export class StyleDriftGate extends Gate {
    private config: Required<StyleDriftConfig>;

    constructor(config: StyleDriftConfig = {}) {
        super('style-drift', 'Style Drift Detection');
        this.config = {
            enabled: config.enabled ?? true,
            deviation_threshold: config.deviation_threshold ?? 0.25,
            sample_size: config.sample_size ?? 100,
            baseline_path: config.baseline_path ?? '.rigour/style-baseline.json',
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
            patterns: context.patterns || ['**/*.{ts,tsx,js,jsx,py}'],
            ignore: [...(context.ignore || []), '**/node_modules/**', '**/dist/**', '**/*.test.*', '**/*.spec.*', '**/*.d.ts'],
        });

        if (files.length === 0) return [];

        // Load or create baseline
        let baseline: StyleFingerprint | null = null;
        if (await fs.pathExists(baselinePath)) {
            try {
                baseline = await fs.readJson(baselinePath);
            } catch {
                Logger.debug('Failed to load style baseline, will create new one');
            }
        }

        if (!baseline) {
            // First scan: create baseline from sampled files
            const sampled = files.slice(0, this.config.sample_size);
            baseline = await this.computeFingerprint(context, sampled);
            baseline.createdAt = new Date().toISOString();

            // Ensure directory exists and save baseline
            await fs.ensureDir(path.dirname(baselinePath));
            await fs.writeJson(baselinePath, baseline, { spaces: 2 });
            Logger.info(`Style Drift: Created baseline from ${sampled.length} files → ${baselinePath}`);
            return []; // No failures on first scan
        }

        // Subsequent scan: compare each file against baseline
        const contents = await FileScanner.readFiles(context.cwd, files, context.fileCache);

        for (const [file, content] of contents) {
            const ext = path.extname(file);
            if (!['.ts', '.tsx', '.js', '.jsx', '.py'].includes(ext)) continue;

            const fileFingerprint = this.analyzeFile(content, ext);
            const deviations = this.compareToBaseline(fileFingerprint, baseline);

            for (const deviation of deviations) {
                if (deviation.score > this.config.deviation_threshold) {
                    failures.push(this.createFailure(
                        `Style drift in ${file}: ${deviation.dimension} deviates ${(deviation.score * 100).toFixed(0)}% from project baseline (${deviation.detail}).`,
                        [file],
                        `This file's ${deviation.dimension} doesn't match the project's established convention. ${deviation.suggestion}`,
                        'Style Drift',
                        undefined,
                        undefined,
                        'low'
                    ));
                }
            }
        }

        if (failures.length > 0) {
            Logger.info(`Style Drift: Found ${failures.length} convention deviations`);
        }

        return failures;
    }

    // ─── Fingerprint Computation ─────────────────────────────────────

    private async computeFingerprint(context: GateContext, files: string[]): Promise<StyleFingerprint> {
        const fingerprint: StyleFingerprint = {
            naming: {
                functions: { camelCase: 0, snake_case: 0, PascalCase: 0, SCREAMING_SNAKE: 0 },
                variables: { camelCase: 0, snake_case: 0, PascalCase: 0, SCREAMING_SNAKE: 0 },
            },
            errorHandling: { tryCatch: 0, promiseCatch: 0, resultType: 0 },
            importStyle: { named: 0, default: 0, wildcard: 0, sideEffect: 0 },
            quoteStyle: { single: 0, double: 0, backtick: 0 },
            totalFilesAnalyzed: 0,
            createdAt: '',
        };

        const contents = await FileScanner.readFiles(context.cwd, files, context.fileCache);

        for (const [file, content] of contents) {
            const ext = path.extname(file);
            const fileAnalysis = this.analyzeFile(content, ext);
            this.mergeIntoFingerprint(fingerprint, fileAnalysis);
            fingerprint.totalFilesAnalyzed++;
        }

        return fingerprint;
    }

    private analyzeFile(content: string, ext: string): StyleFingerprint {
        const fp: StyleFingerprint = {
            naming: {
                functions: { camelCase: 0, snake_case: 0, PascalCase: 0, SCREAMING_SNAKE: 0 },
                variables: { camelCase: 0, snake_case: 0, PascalCase: 0, SCREAMING_SNAKE: 0 },
            },
            errorHandling: { tryCatch: 0, promiseCatch: 0, resultType: 0 },
            importStyle: { named: 0, default: 0, wildcard: 0, sideEffect: 0 },
            quoteStyle: { single: 0, double: 0, backtick: 0 },
            totalFilesAnalyzed: 1,
            createdAt: '',
        };

        const lines = content.split('\n');

        for (const line of lines) {
            // ── Naming conventions ──
            // Function declarations
            const fnMatch = line.match(/(?:function|async\s+function)\s+(\w+)/);
            if (fnMatch) this.classifyCasing(fnMatch[1], fp.naming.functions);

            // Method definitions
            const methodMatch = line.match(/^\s+(?:async\s+)?(\w+)\s*\([^)]*\)\s*[{:]/);
            if (methodMatch && !['if', 'for', 'while', 'switch', 'catch', 'constructor'].includes(methodMatch[1])) {
                this.classifyCasing(methodMatch[1], fp.naming.functions);
            }

            // Arrow function assignments
            const arrowMatch = line.match(/(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|(\w+))\s*=>/);
            if (arrowMatch) this.classifyCasing(arrowMatch[1], fp.naming.functions);

            // Variable declarations (non-function)
            const varMatch = line.match(/(?:const|let|var)\s+(\w+)\s*=/);
            if (varMatch && !arrowMatch) this.classifyCasing(varMatch[1], fp.naming.variables);

            // Python function/variable
            if (ext === '.py') {
                const pyFn = line.match(/def\s+(\w+)/);
                if (pyFn) this.classifyCasing(pyFn[1], fp.naming.functions);

                const pyVar = line.match(/^(\w+)\s*=/);
                if (pyVar && !pyFn) this.classifyCasing(pyVar[1], fp.naming.variables);
            }

            // ── Error handling ──
            if (/\btry\s*\{/.test(line) || /\btry\s*:/.test(line)) fp.errorHandling.tryCatch++;
            if (/\.catch\s*\(/.test(line)) fp.errorHandling.promiseCatch++;
            if (/Result<|Result\[|Err\(|Ok\(|Either</.test(line)) fp.errorHandling.resultType++;

            // ── Import style ──
            if (/^import\s+\{/.test(line.trim())) fp.importStyle.named++;
            else if (/^import\s+\*\s+as/.test(line.trim())) fp.importStyle.wildcard++;
            else if (/^import\s+['"]/.test(line.trim())) fp.importStyle.sideEffect++;
            else if (/^import\s+\w/.test(line.trim())) fp.importStyle.default++;

            // ── Quote style ──
            // Count quotes in non-import lines (imports are already counted above)
            if (!line.trim().startsWith('import')) {
                const singles = (line.match(/'/g) || []).length;
                const doubles = (line.match(/"/g) || []).length;
                const backticks = (line.match(/`/g) || []).length;
                fp.quoteStyle.single += singles;
                fp.quoteStyle.double += doubles;
                fp.quoteStyle.backtick += backticks;
            }
        }

        return fp;
    }

    private classifyCasing(name: string, dist: CasingDistribution): void {
        if (name.startsWith('_') || name.length <= 1) return; // Skip private/single char

        if (/^[A-Z][A-Z0-9_]+$/.test(name)) {
            dist.SCREAMING_SNAKE++;
        } else if (/^[A-Z]/.test(name)) {
            dist.PascalCase++;
        } else if (name.includes('_')) {
            dist.snake_case++;
        } else {
            dist.camelCase++;
        }
    }

    private mergeIntoFingerprint(target: StyleFingerprint, source: StyleFingerprint): void {
        // Naming
        for (const key of Object.keys(target.naming.functions) as (keyof CasingDistribution)[]) {
            target.naming.functions[key] += source.naming.functions[key];
            target.naming.variables[key] += source.naming.variables[key];
        }
        // Error handling
        target.errorHandling.tryCatch += source.errorHandling.tryCatch;
        target.errorHandling.promiseCatch += source.errorHandling.promiseCatch;
        target.errorHandling.resultType += source.errorHandling.resultType;
        // Import style
        target.importStyle.named += source.importStyle.named;
        target.importStyle.default += source.importStyle.default;
        target.importStyle.wildcard += source.importStyle.wildcard;
        target.importStyle.sideEffect += source.importStyle.sideEffect;
        // Quote style
        target.quoteStyle.single += source.quoteStyle.single;
        target.quoteStyle.double += source.quoteStyle.double;
        target.quoteStyle.backtick += source.quoteStyle.backtick;
    }

    // ─── Baseline Comparison ─────────────────────────────────────────

    private compareToBaseline(file: StyleFingerprint, baseline: StyleFingerprint): {
        dimension: string;
        score: number;
        detail: string;
        suggestion: string;
    }[] {
        const deviations: { dimension: string; score: number; detail: string; suggestion: string }[] = [];

        // Compare function naming
        const fnDev = this.distributionDeviation(this.toRecord(file.naming.functions), this.toRecord(baseline.naming.functions));
        if (fnDev.score > 0) {
            deviations.push({
                dimension: 'function naming',
                score: fnDev.score,
                detail: `file uses ${fnDev.filePredominant}, project uses ${fnDev.baselinePredominant}`,
                suggestion: `Use ${fnDev.baselinePredominant} for function names to match project conventions.`,
            });
        }

        // Compare variable naming
        const varDev = this.distributionDeviation(this.toRecord(file.naming.variables), this.toRecord(baseline.naming.variables));
        if (varDev.score > 0) {
            deviations.push({
                dimension: 'variable naming',
                score: varDev.score,
                detail: `file uses ${varDev.filePredominant}, project uses ${varDev.baselinePredominant}`,
                suggestion: `Use ${varDev.baselinePredominant} for variable names to match project conventions.`,
            });
        }

        // Compare error handling
        const errDev = this.distributionDeviation(
            file.errorHandling as Record<string, number>,
            baseline.errorHandling as Record<string, number>
        );
        if (errDev.score > 0 && this.hasSignificantData(file.errorHandling)) {
            deviations.push({
                dimension: 'error handling',
                score: errDev.score,
                detail: `file uses ${errDev.filePredominant}, project uses ${errDev.baselinePredominant}`,
                suggestion: `Use ${errDev.baselinePredominant} error handling pattern to match project conventions.`,
            });
        }

        // Compare import style
        const impDev = this.distributionDeviation(
            file.importStyle as Record<string, number>,
            baseline.importStyle as Record<string, number>
        );
        if (impDev.score > 0 && this.hasSignificantData(file.importStyle)) {
            deviations.push({
                dimension: 'import style',
                score: impDev.score,
                detail: `file uses ${impDev.filePredominant}, project uses ${impDev.baselinePredominant}`,
                suggestion: `Use ${impDev.baselinePredominant} imports to match project conventions.`,
            });
        }

        return deviations;
    }

    /**
     * Compare two distributions and return a deviation score (0-1).
     * 0 = perfect match, 1 = completely different predominant style.
     *
     * Method: find the predominant category in each distribution.
     * If they differ, score = how far the file is from the baseline's predominant category.
     */
    private distributionDeviation(
        file: Record<string, number>,
        baseline: Record<string, number>
    ): { score: number; filePredominant: string; baselinePredominant: string } {
        const fileTotal = Object.values(file).reduce((a, b) => a + b, 0);
        const baselineTotal = Object.values(baseline).reduce((a, b) => a + b, 0);

        if (fileTotal < 3 || baselineTotal < 5) {
            return { score: 0, filePredominant: 'N/A', baselinePredominant: 'N/A' };
        }

        // Find predominant category
        const filePredominant = Object.entries(file).sort((a, b) => b[1] - a[1])[0][0];
        const baselinePredominant = Object.entries(baseline).sort((a, b) => b[1] - a[1])[0][0];

        if (filePredominant === baselinePredominant) {
            return { score: 0, filePredominant, baselinePredominant };
        }

        // Calculate how much the file uses the baseline's predominant style
        const fileUseOfBaseline = (file[baselinePredominant] || 0) / fileTotal;
        const baselineUseOfBaseline = (baseline[baselinePredominant] || 0) / baselineTotal;

        // Score = how far the file deviates from baseline's predominant ratio
        const deviation = Math.max(0, baselineUseOfBaseline - fileUseOfBaseline);

        return { score: deviation, filePredominant, baselinePredominant };
    }

    private hasSignificantData(obj: Record<string, number> | CasingDistribution): boolean {
        return Object.values(obj).reduce((a: number, b: number) => a + b, 0) >= 3;
    }

    /** Convert a typed distribution to a generic Record for comparison */
    private toRecord(dist: CasingDistribution): Record<string, number> {
        return {
            camelCase: dist.camelCase,
            snake_case: dist.snake_case,
            PascalCase: dist.PascalCase,
            SCREAMING_SNAKE: dist.SCREAMING_SNAKE,
        };
    }
}
