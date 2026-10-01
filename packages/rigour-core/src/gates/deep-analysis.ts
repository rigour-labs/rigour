/**
 * Deep Analysis Gate — LLM-powered code analysis.
 *
 * Two modes:
 * - Unscoped (`rigour check --deep`): repo-wide analysis from AST facts.
 *   AST extracts facts, the LLM interprets them, AST verifies the findings.
 * - Scoped (`rigour check <paths> --deep`, `rigour review --deep`): each
 *   scoped file is reviewed with its numbered source; findings must cite a
 *   line and identifiers that were actually sent.
 *
 * The gate records an outcome. A run where setup failed or every chunk
 * failed is an error, never a clean pass.
 */
import { Gate, GateContext } from './base.js';
import { Failure, Provenance, DeepOptions } from '../types/index.js';
import { createProvider, type InferenceProvider, type DeepFinding, type InferenceOptions } from '../inference/index.js';
import type { InferenceUsage } from '../inference/types.js';
import { SidecarProvider } from '../inference/sidecar-provider.js';
import { extractFacts, verifyFindings, type FileFacts } from '../deep/index.js';
import { runFactsPass, type PassResult } from '../deep/facts-pass.js';
import { runCodePass } from '../deep/code-pass.js';
import { routeFiles, type RouterPolicy, type RouterStats } from '../deep/router.js';
import { reviewedKeys } from '../review/ledger.js';
import { buildReviewTask } from '../review/review-task.js';
import { reviewPullRequest } from '../deep/pr-review.js';
import { relatedChanges } from '../deep/related-changes.js';
import { rankChangedFunctions } from '../deep/risk.js';
import { lessonsForDiff, lessonsSection, type LessonMode } from '../review-learning/team-lessons.js';
import { verifyCodeFindings } from '../deep/code-verifier.js';
import { runIntentChecks } from './deep-intent.js';
import type { VerifiedFinding } from '../deep/verifier.js';
import { checkLocalPatterns } from '../storage/local-memory.js';
import { isScoped } from '../utils/scope.js';
import { Logger } from '../utils/logger.js';
import path from 'path';

/** Cloud setup (API connection) must not hang a check. Local setup is bounded by download stall timeouts instead. */
const CLOUD_SETUP_TIMEOUT_MS = 120_000;
/**
 * Source budget per file in the code-review prompt. Local: ~36k chars is
 * ~12k tokens; measured on Apple Silicon at ~19s per file for the 1.5B model
 * (prompt eval ~670 tok/s), inside the 60s per-call timeout.
 */
const LOCAL_SOURCE_CHARS = 36_000;
const CLOUD_SOURCE_CHARS = 60_000;
/** Reference material (removed lines, callees, callers, PR intent) for the max and cloud tiers. */
const LOCAL_REFERENCE_CHARS = 12_000;
const CLOUD_REFERENCE_CHARS = 24_000;
/** Files reviewed at once on a cloud provider; a local sidecar serves one request at a time. */
const CLOUD_CONCURRENCY = 4;

export interface DeepGateConfig {
    options: DeepOptions;
    checks?: Record<string, boolean>;
    threads?: number;
    maxTokens?: number;
    temperature?: number;
    timeoutMs?: number;
    /** Cloud tier: let the model read the repository while it reviews (default on). */
    agentic?: boolean;
    /** Cloud tier: review only the riskiest changed functions. */
    router?: RouterPolicy;
    /** Which of the team's review lessons the reviewer is told about. */
    reviewLessons?: LessonMode;
    /** Whole-run budget: files not started in time are skipped and counted, never an error. */
    budgetMs?: number;
    /** Ask intent questions at engine-proven sites in scoped reviews (deep-intent.ts). */
    intentChecks?: boolean;
    onProgress?: (message: string) => void;
}

export type DeepRunStatus = 'ok' | 'partial' | 'error';

export interface DeepRunOutcome {
    status: DeepRunStatus;
    mode: 'facts' | 'code';
    filesAnalyzed: number;
    chunksTotal: number;
    chunksFailed: number;
    /** Code mode: findings the model proposed, and how many the self-check withdrew. */
    findingsProposed?: number;
    findingsWithdrawn?: number;
    /** Findings the grounding check dropped, by reason. */
    findingsRejected?: Record<string, number>;
    /** Files the run budget left unreviewed. */
    filesSkipped?: number;
    /** Repository lookups the model made (agentic review). */
    toolCalls?: number;
    router?: RouterStats;
    /** Tokens and cost, for cloud providers. */
    usage?: InferenceUsage;
    /** Model actually used (the stock fallback is named as such). */
    model?: string;
    modelFallback?: boolean;
    error?: string;
}

export class DeepAnalysisGate extends Gate {
    private config: DeepGateConfig;
    private provider: InferenceProvider | null = null;
    private outcome: DeepRunOutcome = emptyOutcome();

    constructor(config: DeepGateConfig) {
        super('deep-analysis', 'Deep Code Quality Analysis');
        this.config = config;
    }

    protected get provenance(): Provenance {
        return 'deep-analysis';
    }

    /** Outcome of the last run(). */
    getOutcome(): DeepRunOutcome {
        return this.outcome;
    }

    async run(context: GateContext): Promise<Failure[]> {
        const startTime = Date.now();
        const scoped = isScoped(context.patterns);
        this.outcome = { ...emptyOutcome(), mode: scoped ? 'code' : 'facts' };

        try {
            await this.setupProvider();
            this.config.onProgress?.('  Extracting code facts...');
            const facts = prioritize(await extractFacts(context.cwd, context.ignore, scoped ? context.patterns : undefined));
            this.outcome.filesAnalyzed = facts.length;
            if (facts.length === 0) {
                this.config.onProgress?.('  No analyzable files found. Check ignore patterns and file extensions.');
                return [];
            }

            const verified = scoped
                ? await this.reviewCode(context.cwd, facts)
                : await this.analyzeFacts(context.cwd, limitFiles(facts, this.config));
            this.config.onProgress?.(`  ✓ ${verified.length} verified findings in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
            const intent = scoped && this.config.intentChecks
                ? await runIntentChecks(context.cwd, facts.map(f => f.path), this.provider!, this.config.onProgress)
                : [];
            return [...verified.map(f => this.toFailure(f)), ...intent];
        } catch (error: any) {
            this.outcome.status = 'error';
            this.outcome.error = error?.message ?? String(error);
            Logger.error(`Deep analysis failed: ${this.outcome.error}`);
            this.config.onProgress?.(`  ⚠ Deep analysis error: ${this.outcome.error}`);
            return [];
        } finally {
            this.outcome.usage = this.provider?.usage?.();
            this.provider?.dispose();
        }
    }

    private async setupProvider(): Promise<void> {
        const { options, onProgress } = this.config;
        onProgress?.('\n  Setting up Rigour Brain...\n');
        const provider = createProvider(options);
        this.provider = provider;

        if (isCloud(this.config.options)) {
            await withTimeout(provider.setup(onProgress), CLOUD_SETUP_TIMEOUT_MS,
                'Deep analysis setup timed out. Check your API key with `rigour settings show`.');
            this.outcome.model = options.modelName || options.provider || 'cloud';
            onProgress?.(`\n  ☁️  Using ${options.provider} API. Code context may be sent to the provider.\n`);
            return;
        }

        await provider.setup(onProgress);
        const active = provider instanceof SidecarProvider ? provider.getActiveModel() : null;
        this.outcome.model = active?.name;
        this.outcome.modelFallback = active?.fallback;
        onProgress?.('\n  🔒 Local sidecar/model execution. Code remains on this machine.\n');
    }

    private async reviewCode(cwd: string, scoped: FileFacts[]): Promise<VerifiedFinding[]> {
        if (this.reviewsWholePr()) return this.reviewPr(cwd, scoped);
        const facts = this.route(cwd, scoped);
        this.config.onProgress?.(`  Reviewing ${facts.length} scoped file(s) with source...`);
        const result = await runCodePass(this.provider!, facts, {
            cwd,
            inference: inferenceOptions(this.config),
            maxSourceChars: isCloud(this.config.options) ? CLOUD_SOURCE_CHARS : LOCAL_SOURCE_CHARS,
            focusLines: this.config.options.focusLines,
            reference: this.referenceOptions(),
            onProgress: this.config.onProgress,
            deadline: this.config.budgetMs ? Date.now() + this.config.budgetMs : undefined,
            concurrency: isCloud(this.config.options) ? CLOUD_CONCURRENCY : 1,
            agentic: isCloud(this.config.options) && this.config.agentic !== false,
        });
        this.recordPass(result);
        this.outcome.findingsProposed = result.proposed;
        this.outcome.findingsWithdrawn = result.withdrawn;
        this.outcome.filesSkipped = result.skipped;
        this.outcome.toolCalls = result.toolCalls;
        if (result.skipped > 0) {
            if (this.outcome.status === 'ok') this.outcome.status = 'partial';
            this.config.onProgress?.(`  ⚠ Run budget reached: ${result.skipped} file(s) not reviewed.`);
        }
        const rejected: Record<string, number> = {};
        const verified = verifyCodeFindings(result.findings, result.contexts, rejected);
        this.outcome.findingsRejected = rejected;
        return verified;
    }

    /** A cloud model that can call tools reviews a change as one PR: it sees how files relate. */
    private reviewsWholePr(): boolean {
        const { options } = this.config;
        return isCloud(options) && this.config.agentic !== false && !!this.provider?.chat && !!options.diff;
    }

    private async reviewPr(cwd: string, scoped: FileFacts[]): Promise<VerifiedFinding[]> {
        const { options } = this.config;
        if (this.route(cwd, scoped).length === 0) {
            this.config.onProgress?.('  Router: no risky change for the model; the gates cover this PR.');
            return [];
        }
        const focus = buildReviewTask(cwd, options.diff!, this.config.router).items;
        const changedFiles = Object.keys(options.focusLines ?? {});
        const related = relatedChanges(cwd, changedFiles, rankChangedFunctions(cwd, options.focusLines ?? {}, options.removedLines));
        this.config.onProgress?.(`  Reviewing the PR as a whole (${focus.length} risky function(s) first)...`);
        try {
            const result = await reviewPullRequest(this.provider!, { cwd, diff: options.diff!, focus, related, lessons: lessonsSection(lessonsForDiff(cwd, options.diff!, this.config.reviewLessons)), prBody: options.prBody }, inferenceOptions(this.config));
            this.recordPass({ findings: [], chunksTotal: 1, chunksFailed: 0 });
            this.outcome.findingsProposed = result.findings.length;
            this.outcome.findingsWithdrawn = 0;
            this.outcome.toolCalls = result.toolCalls;
            const rejected: Record<string, number> = {};
            const verified = verifyCodeFindings(result.findings, result.contexts, rejected);
            this.outcome.findingsRejected = rejected;
            return verified;
        } catch (error: any) {
            this.recordPass({ findings: [], chunksTotal: 1, chunksFailed: 1, firstError: error?.message ?? String(error) });
            return [];
        }
    }

    /** Cloud only: a paid model reviews the riskiest changed functions; local tiers cost nothing to run. */
    private route(cwd: string, facts: FileFacts[]): FileFacts[] {
        const { options } = this.config;
        if (!isCloud(options) || this.config.router?.enabled === false || !options.focusLines) return facts;
        const routed = routeFiles(cwd, facts.map(f => f.path), options.focusLines, options.removedLines, this.config.router, reviewedKeys(cwd));
        this.outcome.router = routed.stats;
        if (routed.stats.files_skipped > 0) {
            this.config.onProgress?.(`  Router: ${routed.stats.routed} of ${routed.stats.functions} changed function(s) to the model; ${routed.stats.files_skipped} file(s) left to the gates.`);
        }
        return facts.filter(f => routed.files.has(f.path));
    }

    /** The max and cloud tiers read reference material and review twice; the small models do not. */
    private referenceOptions() {
        const options = this.config.options;
        const cloud = isCloud(options);
        if (!cloud && !options.max) return undefined;
        return { maxChars: cloud ? CLOUD_REFERENCE_CHARS : LOCAL_REFERENCE_CHARS, removed: options.removedLines, prBody: options.prBody };
    }

    private async analyzeFacts(cwd: string, facts: FileFacts[]): Promise<VerifiedFinding[]> {
        this.config.onProgress?.(`  Found ${facts.length} files to analyze.`);
        const memory = await this.localMemoryFindings(cwd, facts);
        const agentCount = this.config.options.agents || 1;
        const result = await runFactsPass(this.provider!, facts, {
            inference: inferenceOptions(this.config),
            checks: this.config.checks,
            onProgress: this.config.onProgress,
            agents: isCloud(this.config.options) && agentCount > 1
                ? { count: agentCount, create: () => this.createCloudAgent() }
                : undefined,
        });
        this.recordPass(result);
        return verifyFindings([...memory, ...result.findings], facts);
    }

    private recordPass(result: PassResult): void {
        this.outcome.chunksTotal = result.chunksTotal;
        this.outcome.chunksFailed = result.chunksFailed;
        if (result.chunksTotal > 0 && result.chunksFailed === result.chunksTotal) {
            this.outcome.status = 'error';
            this.outcome.error = `All ${result.chunksTotal} inference call(s) failed. First error: ${result.firstError ?? 'unknown'}`;
        } else if (result.chunksFailed > 0) {
            this.outcome.status = 'partial';
            this.config.onProgress?.(`  ⚠ ${result.chunksFailed}/${result.chunksTotal} batches failed — results are incomplete.`);
        }
    }

    private async localMemoryFindings(cwd: string, facts: FileFacts[]): Promise<DeepFinding[]> {
        try {
            const found = await checkLocalPatterns(cwd, facts.map(f => f.path).filter(Boolean));
            if (found.length > 0) this.config.onProgress?.(`  🧠 Local memory: ${found.length} known pattern(s) matched instantly.`);
            return found;
        } catch (error: any) {
            Logger.debug(`Local memory check skipped (${error.message?.substring(0, 80)})`);
            return [];
        }
    }

    private async createCloudAgent(): Promise<InferenceProvider> {
        const provider = createProvider(this.config.options);
        await provider.setup();
        return provider;
    }

    private toFailure(finding: VerifiedFinding): Failure {
        const failure = this.createFailure(
            finding.description,
            [finding.file],
            finding.suggestion,
            `[${finding.category}] ${finding.description.substring(0, 80)}`,
            finding.line,
            undefined,
            finding.severity,
        );
        return { ...failure, confidence: finding.confidence, source: 'llm', category: finding.category, verified: finding.verified };
    }
}

/** Cloud when an API key and a non-local provider are set (same rule as createProvider). */
function isCloud(options: DeepOptions): boolean {
    return !!options.apiKey && !!options.provider && options.provider !== 'local';
}

/** Per-call options; unset config falls back to per-provider defaults. */
/** Per-call inference timeout: a local 7B reads a file with its reference pack far slower than the small tiers. */
export function defaultTimeout(options: DeepOptions): number {
    if (isCloud(options)) return 120_000;
    return options.max ? 240_000 : 60_000;
}

function inferenceOptions(config: DeepGateConfig): InferenceOptions {
    const cloud = isCloud(config.options);
    return {
        maxTokens: config.maxTokens ?? (cloud ? 4096 : 1024),
        temperature: config.temperature ?? 0.1,
        timeout: config.timeoutMs ?? defaultTimeout(config.options),
        jsonMode: true,
    };
}

function limitFiles(facts: FileFacts[], config: DeepGateConfig): FileFacts[] {
    const max = config.options.maxFiles;
    if (!max || facts.length <= max) return facts;
    config.onProgress?.(`  Limiting to ${max} files (configured in rigour.yml).`);
    return facts.slice(0, max);
}

function emptyOutcome(): DeepRunOutcome {
    return { status: 'ok', mode: 'facts', filesAnalyzed: 0, chunksTotal: 0, chunksFailed: 0 };
}

/** Entry points first, then larger files. */
function prioritize(facts: FileFacts[]): FileFacts[] {
    return [...facts].sort((a, b) => {
        const entry = Number(isEntryPoint(b.path)) - Number(isEntryPoint(a.path));
        return entry !== 0 ? entry : b.lineCount - a.lineCount;
    });
}

const ENTRY_POINTS = new Set([
    'index.ts', 'index.js', 'index.tsx', 'index.jsx', 'index.mjs',
    'main.ts', 'main.js', 'main.py', 'main.go', 'main.rs', 'main.java', 'main.kt',
    'app.ts', 'app.js', 'app.py', 'app.go', 'app.rb',
    'server.ts', 'server.js', 'server.py', 'server.go',
    'mod.rs', 'lib.rs',
]);

function isEntryPoint(filePath: string): boolean {
    return ENTRY_POINTS.has(path.basename(filePath).toLowerCase());
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}
