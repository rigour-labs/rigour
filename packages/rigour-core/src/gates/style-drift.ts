/**
 * Style Drift Detection Gate
 *
 * Detects when AI-generated code gradually drifts away from the project's
 * established coding conventions. AI models tend to use their own "default"
 * style which may differ from the project norm.
 *
 * What it checks:
 * 1. Naming conventions — compare names with the same language conventions
 * 2. Error handling patterns — try-catch vs .catch()/except/rescue consistency
 *
 * How it works:
 * 1. First scan: sample source files → compute per-language style fingerprints → store baseline
 * 2. Subsequent scans: compare new/changed files against their language's baseline
 * 3. If a file deviates >25% on any dimension → flag as style drift
 *
 * Baselines are per-language to avoid cross-language contamination
 * (e.g., Python snake_case should not flag JS camelCase).
 * JS names mandated by frameworks are excluded from style comparison, and
 * imports are never compared by a language-wide named/default ratio.
 */

import { Gate, GateContext } from './base.js';
import { Failure, Provenance } from '../types/index.js';
import { FileScanner } from '../utils/scanner.js';
import { Logger } from '../utils/logger.js';
import { languageAdapters } from './language-adapters/index.js';
import { extractComparableJsNames } from './js-style-context.js';
import { isScoped } from '../utils/scope.js';
import { filesAtCommit, isGitWorktree, NO_GIT_BASE, readManyAtCommit, resolveGitLogicBase, untrackedFiles, type GitLogicBase } from './logic-drift-git-base.js';
import {
    TRY_CATCH_PATTERN, CATCH_PATTERN, RESULT_TYPE_PATTERN,
    NAMED_IMPORT_PATTERN, WILDCARD_IMPORT_PATTERN, SIDE_EFFECT_IMPORT_PATTERN, DEFAULT_IMPORT_PATTERN,
    countQuotes,
} from './style-drift-rules.js';
import fs from 'fs-extra';
import path from 'path';

export interface StyleDriftConfig {
    enabled?: boolean;
    deviation_threshold?: number;  // 0-1, default 0.25 (25% deviation triggers alert)
    sample_size?: number;          // Max files to sample per language for baseline, default 50
    baseline_path?: string;        // Where to store baseline, default .rigour/style-baseline.json
}

interface CasingDistribution {
    camelCase: number;
    snake_case: number;
    PascalCase: number;
    SCREAMING_SNAKE: number;
    'kebab-case'?: number;
    other?: number;
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

/** Per-language baselines — each language gets its own fingerprint */
interface PerLanguageBaseline {
    languages: Record<string, StyleFingerprint>;
    createdAt: string;
    version: 3;  // Framework-aware JS naming requires a refreshed baseline
}

export class StyleDriftGate extends Gate {
    private config: Required<StyleDriftConfig>;

    constructor(config: StyleDriftConfig = {}) {
        super('style-drift', 'Style Drift Detection');
        this.config = {
            enabled: config.enabled ?? true,
            deviation_threshold: config.deviation_threshold ?? 0.25,
            sample_size: config.sample_size ?? 50,
            baseline_path: config.baseline_path ?? '.rigour/style-baseline.json',
        };
    }

    protected get provenance(): Provenance { return 'ai-drift'; }

    async run(context: GateContext): Promise<Failure[]> {
        if (!this.config.enabled) return [];

        const baselinePath = path.join(context.cwd, this.config.baseline_path);

        // Find source files
        const ignore = [...(context.ignore || []), '**/node_modules/**', '**/dist/**', '**/*.test.*', '**/*.spec.*', '**/*.d.ts'];
        const files = await FileScanner.findFiles({
            cwd: context.cwd,
            patterns: context.patterns || languageAdapters.getScanPatterns(),
            ignore,
        });

        if (files.length === 0) return [];

        // In a git checkout the project's style is the code committed at the base, read fresh on every run, and
        // only the files that differ from it are compared. Nothing is cached, so no earlier run on a dirty tree
        // can change a verdict, and a .rigour/style-baseline.json left by an older version is never read.
        const gitBase = resolveGitLogicBase(context.cwd);
        if (!gitBase && isGitWorktree(context.cwd)) {
            context.skip?.(NO_GIT_BASE);
            return [];
        }
        if (gitBase) return this.againstGitBase(context, files, ignore, gitBase);

        // Group files by language
        const filesByLang = new Map<string, string[]>();
        for (const file of files) {
            const adapter = languageAdapters.getAdapter(file);
            if (!adapter) continue;
            const langFiles = filesByLang.get(adapter.id) || [];
            langFiles.push(file);
            filesByLang.set(adapter.id, langFiles);
        }

        // Load or create baseline
        let baseline: PerLanguageBaseline | null = null;
        if (await fs.pathExists(baselinePath)) {
            try {
                const raw = await fs.readJson(baselinePath);
                // Handle migration from old single-fingerprint format
                if (raw.version === 3) {
                    baseline = raw;
                } else {
                    Logger.debug('Old style baseline format detected, creating new per-language baseline');
                }
            } catch {
                Logger.debug('Failed to load style baseline, will create new one');
            }
        }

        if (!baseline && isScoped(context.patterns)) return []; // never baseline from a subset of files
        if (!baseline) {
            // First scan: create per-language baseline
            baseline = await this.computePerLanguageBaseline(context, filesByLang);

            await fs.ensureDir(path.dirname(baselinePath));
            await fs.writeJson(baselinePath, baseline, { spaces: 2 });

            const langSummary = Object.entries(baseline.languages)
                .map(([lang, fp]) => `${lang}:${fp.totalFilesAnalyzed}`)
                .join(', ');
            Logger.info(`Style Drift: Created baseline (${langSummary}) → ${baselinePath}`);
            return []; // No failures on first scan
        }

        // Subsequent scan: compare each file against its own language's baseline
        return this.compare(context, files, baseline);
    }

    /**
     * The changed and untracked files, each against a fingerprint of its language's files committed at the base.
     * On the base branch with a clean tree nothing differs, so nothing is compared.
     */
    private async againstGitBase(context: GateContext, files: string[], ignore: string[], gitBase: GitLogicBase): Promise<Failure[]> {
        const changed = new Set([...gitBase.changedFiles, ...untrackedFiles(context.cwd)]);
        const compared = files.filter(file => changed.has(file));
        if (compared.length === 0) return [];

        const languages = new Set(compared.map(file => languageAdapters.getAdapter(file)?.id));
        const sampled = new Map<string, string[]>();
        for (const file of FileScanner.filterPaths(filesAtCommit(context.cwd, gitBase.base), { patterns: languageAdapters.getScanPatterns(), ignore })) {
            const id = languageAdapters.getAdapter(file)?.id;
            if (!id || !languages.has(id)) continue;
            const list = sampled.get(id) ?? [];
            if (list.length < this.config.sample_size) list.push(file);
            sampled.set(id, list);
        }
        const atBase = readManyAtCommit(context.cwd, gitBase.base, [...sampled.values()].flat());
        const baseline: PerLanguageBaseline = { languages: {}, createdAt: '', version: 3 };
        for (const [id, list] of sampled) {
            baseline.languages[id] = this.fingerprintOf(new Map(list.flatMap(file => atBase.has(file) ? [[file, atBase.get(file)!] as [string, string]] : [])));
        }
        return this.compare(context, compared, baseline);
    }

    /** Each file against its own language's fingerprint. */
    private async compare(context: GateContext, files: string[], baseline: PerLanguageBaseline): Promise<Failure[]> {
        const failures: Failure[] = [];
        const contents = await FileScanner.readFiles(context.cwd, files, context.fileCache);

        for (const [file, content] of contents) {
            const adapter = languageAdapters.getAdapter(file);
            if (!adapter) continue;

            const langBaseline = baseline.languages[adapter.id];
            if (!langBaseline) continue;  // No baseline for this language yet

            const fileFingerprint = this.analyzeFile(content, file);
            const deviations = this.compareToBaseline(fileFingerprint, langBaseline);

            for (const deviation of deviations) {
                if (deviation.score > this.config.deviation_threshold) {
                    failures.push(this.createFailure(
                        `Style drift in ${file}: ${deviation.dimension} deviates ${(deviation.score * 100).toFixed(0)}% from ${adapter.id} baseline (${deviation.detail}).`,
                        [file],
                        `This file's ${deviation.dimension} doesn't match the ${adapter.id} project convention. ${deviation.suggestion}`,
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

    // ─── Per-Language Baseline Computation ────────────────────────────

    private async computePerLanguageBaseline(
        context: GateContext,
        filesByLang: Map<string, string[]>,
    ): Promise<PerLanguageBaseline> {
        const baseline: PerLanguageBaseline = {
            languages: {},
            createdAt: new Date().toISOString(),
            version: 3,
        };

        for (const [langId, langFiles] of filesByLang) {
            // Sample up to sample_size files per language
            const sampled = langFiles.slice(0, this.config.sample_size);
            const fingerprint = await this.computeFingerprint(context, sampled);
            fingerprint.createdAt = baseline.createdAt;
            baseline.languages[langId] = fingerprint;
        }

        return baseline;
    }

    private async computeFingerprint(context: GateContext, files: string[]): Promise<StyleFingerprint> {
        return this.fingerprintOf(await FileScanner.readFiles(context.cwd, files, context.fileCache));
    }

    private fingerprintOf(contents: Map<string, string>): StyleFingerprint {
        const fingerprint = this.emptyFingerprint();

        for (const [file, content] of contents) {
            const fileAnalysis = this.analyzeFile(content, file);
            this.mergeIntoFingerprint(fingerprint, fileAnalysis);
            fingerprint.totalFilesAnalyzed++;
        }

        return fingerprint;
    }

    private emptyFingerprint(): StyleFingerprint {
        return {
            naming: {
                functions: { camelCase: 0, snake_case: 0, PascalCase: 0, SCREAMING_SNAKE: 0, 'kebab-case': 0, other: 0 },
                variables: { camelCase: 0, snake_case: 0, PascalCase: 0, SCREAMING_SNAKE: 0, 'kebab-case': 0, other: 0 },
            },
            errorHandling: { tryCatch: 0, promiseCatch: 0, resultType: 0 },
            importStyle: { named: 0, default: 0, wildcard: 0, sideEffect: 0 },
            quoteStyle: { single: 0, double: 0, backtick: 0 },
            totalFilesAnalyzed: 0,
            createdAt: '',
        };
    }

    private analyzeFile(content: string, filePath: string): StyleFingerprint {
        const fp = this.emptyFingerprint();
        fp.totalFilesAnalyzed = 1;

        const lines = content.split('\n');
        const adapter = languageAdapters.getAdapter(filePath);

        // ── Naming conventions (via adapter) ──
        if (adapter) {
            const namingPatterns = adapter.id === 'js'
                ? extractComparableJsNames(content, filePath)
                : adapter.extractNamingPatterns(content);
            for (const pattern of namingPatterns) {
                if (pattern.convention === 'ambiguous') continue; // a one-word name says nothing about the casing
                if (pattern.kind === 'function' || pattern.kind === 'method') {
                    fp.naming.functions[pattern.convention]++;
                } else if (pattern.kind === 'variable' || pattern.kind === 'constant') {
                    fp.naming.variables[pattern.convention]++;
                }
            }
        }

        for (const line of lines) {
            // ── Error handling ──
            if (TRY_CATCH_PATTERN.test(line)) fp.errorHandling.tryCatch++;
            if (CATCH_PATTERN.test(line)) fp.errorHandling.promiseCatch++;
            if (RESULT_TYPE_PATTERN.test(line)) fp.errorHandling.resultType++;

            // ── Import style ──
            if (NAMED_IMPORT_PATTERN.test(line.trim())) fp.importStyle.named++;
            else if (WILDCARD_IMPORT_PATTERN.test(line.trim())) fp.importStyle.wildcard++;
            else if (SIDE_EFFECT_IMPORT_PATTERN.test(line.trim())) fp.importStyle.sideEffect++;
            else if (DEFAULT_IMPORT_PATTERN.test(line.trim())) fp.importStyle.default++;

            // ── Quote style ──
            if (!line.trim().startsWith('import')) {
                const quotes = countQuotes(line);
                fp.quoteStyle.single += quotes.single;
                fp.quoteStyle.double += quotes.double;
                fp.quoteStyle.backtick += quotes.backtick;
            }
        }

        return fp;
    }

    private mergeIntoFingerprint(target: StyleFingerprint, source: StyleFingerprint): void {
        for (const key of Object.keys(target.naming.functions) as (keyof CasingDistribution)[]) {
            const targetVal = target.naming.functions[key] ?? 0;
            const sourceVal = source.naming.functions[key] ?? 0;
            target.naming.functions[key] = (targetVal as number) + (sourceVal as number);

            const targetVarVal = target.naming.variables[key] ?? 0;
            const sourceVarVal = source.naming.variables[key] ?? 0;
            target.naming.variables[key] = (targetVarVal as number) + (sourceVarVal as number);
        }
        target.errorHandling.tryCatch += source.errorHandling.tryCatch;
        target.errorHandling.promiseCatch += source.errorHandling.promiseCatch;
        target.errorHandling.resultType += source.errorHandling.resultType;
        target.importStyle.named += source.importStyle.named;
        target.importStyle.default += source.importStyle.default;
        target.importStyle.wildcard += source.importStyle.wildcard;
        target.importStyle.sideEffect += source.importStyle.sideEffect;
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

        const fnDev = this.distributionDeviation(this.toRecord(file.naming.functions), this.toRecord(baseline.naming.functions));
        if (fnDev.score > 0) {
            deviations.push({
                dimension: 'function naming',
                score: fnDev.score,
                detail: `file uses ${fnDev.filePredominant}, project uses ${fnDev.baselinePredominant}`,
                suggestion: `Use ${fnDev.baselinePredominant} for function names to match project conventions.`,
            });
        }

        const varDev = this.distributionDeviation(this.toRecord(file.naming.variables), this.toRecord(baseline.naming.variables));
        if (varDev.score > 0) {
            deviations.push({
                dimension: 'variable naming',
                score: varDev.score,
                detail: `file uses ${varDev.filePredominant}, project uses ${varDev.baselinePredominant}`,
                suggestion: `Use ${varDev.baselinePredominant} for variable names to match project conventions.`,
            });
        }

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

        // Import form depends on the imported module's exports. A language-wide
        // named/default ratio cannot establish a valid replacement.

        return deviations;
    }

    private distributionDeviation(
        file: Record<string, number>,
        baseline: Record<string, number>
    ): { score: number; filePredominant: string; baselinePredominant: string } {
        const fileTotal = Object.values(file).reduce((a, b) => a + b, 0);
        const baselineTotal = Object.values(baseline).reduce((a, b) => a + b, 0);

        if (fileTotal < 3 || baselineTotal < 5) {
            return { score: 0, filePredominant: 'N/A', baselinePredominant: 'N/A' };
        }

        const filePredominant = Object.entries(file).sort((a, b) => b[1] - a[1])[0][0];
        const baselinePredominant = Object.entries(baseline).sort((a, b) => b[1] - a[1])[0][0];

        if (filePredominant === baselinePredominant) {
            return { score: 0, filePredominant, baselinePredominant };
        }

        const fileUseOfBaseline = (file[baselinePredominant] || 0) / fileTotal;
        const baselineUseOfBaseline = (baseline[baselinePredominant] || 0) / baselineTotal;
        const deviation = Math.max(0, baselineUseOfBaseline - fileUseOfBaseline);

        return { score: deviation, filePredominant, baselinePredominant };
    }

    private hasSignificantData(obj: Record<string, number> | CasingDistribution): boolean {
        return Object.values(obj).reduce((a: number, b: number) => a + b, 0) >= 3;
    }

    private toRecord(dist: CasingDistribution): Record<string, number> {
        return {
            camelCase: dist.camelCase,
            snake_case: dist.snake_case,
            PascalCase: dist.PascalCase,
            SCREAMING_SNAKE: dist.SCREAMING_SNAKE,
            'kebab-case': dist['kebab-case'] || 0,
            other: dist.other || 0,
        };
    }
}
