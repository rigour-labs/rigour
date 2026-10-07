/**
 * `rigour review`: quality gates on a change, filtered to the lines it touches.
 *
 * The review itself is core's reviewChange(), shared with the MCP
 * `rigour_review` tool, so the same change gets the same verdict everywhere.
 * The diff comes from --diff, else from stdin, else from git: uncommitted
 * work by default, or the branch against --base (a pull request).
 *
 * Usage:
 *   rigour review                         # uncommitted changes, from git
 *   rigour review --base main --json      # this branch against main
 *   git diff | rigour review --json
 *   rigour review --diff changes.patch
 */
import { execFileSync } from 'child_process';
import fs from 'fs-extra';
import path from 'path';
import chalk from 'chalk';
import { buildReviewTask, costBucket, diffFromGit, durationBucket, flushDailyUsage, Logger, LogLevel, resolveDeepOptions, trackUsage, reviewChange, toReviewFinding, GitDiffError, mergeBaseOf, receiptReport, recordPrCatches, reviewerBlocks } from '@rigour-labs/core';
import type { DeepOptions, DiffSource, QualityReceipt, ReviewerResult, ReviewResult } from '@rigour-labs/core';
import { receiptFor } from './review-receipt.js';
import { printReviewer, printStatus, reviewerBase, reviewerFor, reviewerJson } from './review-reviewer.js';
import { printHuman, type HumanContext } from './review-human.js';
import { printScope } from './review-scope.js';
import { loadConfig, UsageError } from './review-config.js';
import { deepProvider } from './deep-provider.js';
import { buildCiReviewSummary, renderGithubSummary } from './review-summary.js';
import { EXIT_PASS, EXIT_FAIL, EXIT_CONFIG_ERROR, EXIT_INTERNAL_ERROR } from './exit-codes.js';

export interface ReviewOptions {
    json?: boolean;
    ci?: boolean;
    githubSummary?: boolean;
    config?: string;
    diff?: string;       // path to diff file
    base?: string;       // review this branch against a base ref
    files?: string;      // comma-separated explicit file list
    deep?: boolean;
    pro?: boolean;
    max?: boolean;
    modelPath?: string;
    prBody?: string;     // path to a file with the PR description
    diffTests?: boolean; // run changed functions before and after the change
    independent?: boolean; // ignore self-reported reviews (ledger, reviewed.json)
    apiKey?: string;
    provider?: string;
    apiBaseUrl?: string;
    modelName?: string;
    reviewer?: boolean;  // run the reviewer (every human review, diff, repo rules) after the rules
    full?: boolean;      // with --reviewer: two vendors, verdicts merged (the step before asking a person to look)
    single?: boolean;    // with --reviewer: one judge for this run
    panel?: boolean;     // with --reviewer: --panel / --no-panel for this run
    status?: boolean;    // what the background reviewer has done for this branch
    all?: boolean;       // every finding, not the first five
    notes?: boolean;     // list the notes that never block
    receipt?: boolean;   // the receipt of agent reviews, even before agents have reviewed anything here
    scope?: string | boolean;  // a fix round's files no point of the review cited (review-scope.ts)
    scopeReview?: string;
}

export async function reviewCommand(cwd: string, options: ReviewOptions = {}) {
    const started = Date.now();
    if (options.status) process.exit(await printStatus(cwd, !!options.json));
    // A person reads the verdict, not each gate's progress; warnings and errors still show.
    if (!options.ci && !options.json && !options.githubSummary) Logger.setLevel(LogLevel.WARN);
    try {
        if (options.scope !== undefined) process.exit(await printScope(cwd, options));
        // An independent PR review trusts Rigour's settings as of the base, not as the PR left them.
        const trustedRef = options.independent && options.base ? mergeBaseOf(cwd, options.base) : undefined;
        const config = await loadConfig(cwd, options, trustedRef);
        const diff = await readDiff(cwd, options);
        const isDeep = !!options.deep || !!options.pro || !!options.max || !!options.apiKey;
        if (options.diffTests && !options.max && !options.apiKey) {
            throw new UsageError('--diff-tests needs a model that can propose test inputs: add --max, or -k for a cloud model.');
        }
        if (!options.ci && !options.json && !options.githubSummary && isDeep) console.log(chalk.blue.bold('Deep analysis enabled.\n'));
        const source = options.base ? { mode: 'base' as const, base: options.base } : { mode: 'working' as const };
        const result = await reviewChange({
            cwd, config, diff, source,
            files: options.files ? options.files.split(',').map(f => f.trim()).filter(Boolean) : undefined,
            diffTests: !!options.diffTests,
            deep: isDeep ? deepOptions(cwd, options) : undefined,
            trustedRef,
            typed: true,
        });
        if (options.base) recordPrCatches(cwd, result.findings);
        const receipt = receiptFor(cwd, diff ?? changeDiff(cwd, source), config, !!options.independent);
        const reviewer = options.reviewer ? await reviewerFor(cwd, reviewerBase(cwd, options.base), config, !!options.full, { ...(options.single ? { mode: 'single' as const } : {}), ...(options.panel !== undefined ? { panel: options.panel } : {}) }, result) : undefined;
        await print(result, options, receipt, reviewer, { cwd, scope: scopeOf(options), commits: commitsOf(cwd, options.base), ms: Date.now() - started });
        if (!isDeep && !receipt && !options.ci && !options.json && !options.githubSummary) {
            hintReviewTask(cwd, diff ?? diffFromGit(cwd, source), config.gates.deep?.router);
        }
        await reportUsage(result, isDeep, options, Date.now() - started);
        process.exit(reviewer && reviewerBlocks(reviewer) ? Math.max(exitCodeFor(result), EXIT_FAIL) : exitCodeFor(result));
    } catch (error: any) {
        fail(error, options);
    }
}

/** --diff, else piped input, else undefined (core then takes the diff from git). */
async function readDiff(cwd: string, options: ReviewOptions): Promise<string | undefined> {
    if (options.diff) {
        const diffPath = path.resolve(cwd, options.diff);
        if (!(await fs.pathExists(diffPath))) throw new UsageError(`Diff file not found: ${diffPath}`);
        return fs.readFile(diffPath, 'utf-8');
    }
    if (!readsStdinDiff(options, stdinStat())) return undefined;
    const piped = await readStdin();
    return piped.trim() ? piped : undefined;
}

/**
 * Piped input is the diff only when no other source was named (--base,
 * --files) and stdin is a pipe or a redirected file. Agents and hooks run
 * commands with stdin left open on a socket that never ends; reading it
 * would wait forever.
 */
export function readsStdinDiff(options: ReviewOptions, stdin: Pick<fs.Stats, 'isFIFO' | 'isFile'> | undefined): boolean {
    if (options.base || options.files) return false;
    return !!stdin && (stdin.isFIFO() || stdin.isFile());
}

function stdinStat(): fs.Stats | undefined {
    try {
        return fs.fstatSync(0);
    } catch {
        return undefined;
    }
}

async function readStdin(): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf-8');
}

/**
 * What the change intends: --pr-body, else the pull request in a GitHub Actions
 * event. It is reference for the max and cloud tiers, never required.
 */
export function readPrBody(cwd: string, options: ReviewOptions, env: NodeJS.ProcessEnv = process.env): string | undefined {
    if (options.prBody) {
        const bodyPath = path.resolve(cwd, options.prBody);
        if (!fs.existsSync(bodyPath)) throw new UsageError(`PR body file not found: ${bodyPath}`);
        return fs.readFileSync(bodyPath, 'utf-8');
    }
    if (!env.GITHUB_EVENT_PATH) return undefined;
    try {
        const event = JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, 'utf-8'));
        const pr = event.pull_request;
        return pr ? [pr.title, pr.body].filter(Boolean).join('\n\n') || undefined : undefined;
    } catch {
        return undefined;
    }
}

function deepOptions(cwd: string, options: ReviewOptions): Omit<DeepOptions, 'focusLines' | 'removedLines'> {
    const resolved = resolveDeepOptions({
        apiKey: options.apiKey, provider: options.provider, apiBaseUrl: options.apiBaseUrl, modelName: options.modelName,
    });
    return {
        enabled: true,
        pro: !!options.pro,
        max: !!options.max,
        modelPath: options.modelPath,
        prBody: readPrBody(cwd, options),
        apiKey: resolved.apiKey,
        provider: deepProvider(options.provider, resolved.provider, resolved.apiKey),
        apiBaseUrl: resolved.apiBaseUrl,
        modelName: resolved.modelName,
        independent: !!options.independent,
    };
}

async function print(result: ReviewResult, options: ReviewOptions, receipt: QualityReceipt | null, reviewer: ReviewerResult | undefined, context: Omit<HumanContext, 'receipt'>): Promise<void> {
    const summary = buildCiReviewSummary(result.findings, result.report?.failures.length ?? 0, result.changedLines,
        result.unlocated + result.fileFindings.length);
    if (options.json) return writeJson(result, summary, receipt, reviewer);
    if (options.githubSummary || options.ci) {
        // The machine-read outputs say why a review is not a pass on stderr; the human one says it in its verdict.
        if (result.deepError) console.error(chalk.red(`Deep analysis did not run: ${result.deepError}`));
        if (result.gateErrors.length) console.error(chalk.yellow(`Checks that could not run, so this is not a pass: ${result.gateErrors.join(', ')}${result.typedError ? ` (${result.typedError})` : ''}`));
        return options.githubSummary ? void console.log(renderGithubSummary(summary)) : printCi(result);
    }
    printHuman(result, { ...context, receipt, all: options.all, notes: options.notes, showReceipt: options.receipt });
    if (reviewer) printReviewer(reviewer);
}

function scopeOf(options: ReviewOptions): string {
    if (options.diff) return 'the diff';
    return options.base ? `this branch against ${options.base}` : 'your uncommitted changes';
}

/** Commits on the branch since it left the base; undefined for uncommitted work or outside git. */
function commitsOf(cwd: string, base: string | undefined): number | undefined {
    if (!base) return undefined;
    try {
        const merged = mergeBaseOf(cwd, base);
        const count = Number(execFileSync('git', ['rev-list', '--count', `${merged}..HEAD`], { cwd, encoding: 'utf8' }).trim());
        return Number.isFinite(count) && count > 0 ? count : undefined;
    } catch {
        return undefined;
    }
}

/** The change as git sees it, for the receipt; undefined outside a git repository. */
function changeDiff(cwd: string, source: DiffSource): string | undefined {
    try {
        return diffFromGit(cwd, source);
    } catch {
        return undefined;
    }
}

function writeJson(result: ReviewResult, summary: ReturnType<typeof buildCiReviewSummary>, receipt: QualityReceipt | null, reviewer?: ReviewerResult): Promise<void> {
    const stats = result.report?.stats;
    const json = JSON.stringify({
        status: result.status,
        score: stats?.score ?? 100,
        ai_health_score: stats?.ai_health_score,
        structural_score: stats?.structural_score,
        total_failures: result.report?.failures.length ?? 0,
        filtered_failures: result.findings.length,
        unlocated_failures: result.unlocated,
        ci_summary: summary,
        ...(stats?.deep ? { deep: stats.deep } : {}),
        failures: result.findings.map(toReviewFinding),
        file_findings: result.fileFindings.map(toReviewFinding),
        context_findings: result.contextFindings.map(toReviewFinding),
        advisory: result.advisory.map(toReviewFinding),
        muted: result.muted,
        dismissed: result.dismissed,
        preexisting: result.preexisting,
        control_files_changed: result.controlFilesChanged,
        hints: result.hints,
        gate_errors: result.gateErrors,
        ...(result.typedError ? { typed_error: result.typedError } : {}),
        ...(receipt ? { receipt: receiptReport(receipt) } : {}),
        ...(reviewer ? { reviewer: reviewerJson(reviewer) } : {}),
    }, null, 2);
    return new Promise(resolve => process.stdout.write(json + '\n', () => resolve()));
}

function printCi(result: ReviewResult): void {
    const score = result.report?.stats.score;
    const scoreStr = score !== undefined ? ` (${score}/100)` : '';
    if (result.findings.length === 0) {
        console.log(`${result.status === 'ERROR' ? 'ERROR' : 'PASS'}${scoreStr}`);
        return;
    }
    console.log(`FAIL: ${result.findings.length} violation(s) on changed lines${scoreStr}`);
    for (const f of result.findings) {
        console.log(`  - [${(f.severity || 'medium').toUpperCase()}] ${f.files?.[0] || ''}:${f.line ?? '?'} ${f.title}`);
    }
}

/** Without a model, point at the risky changed functions a person or their agent should still check. */
function hintReviewTask(cwd: string, diff: string, router: Parameters<typeof buildReviewTask>[2]): void {
    try {
        const pending = buildReviewTask(cwd, diff, router).items.length;
        if (pending) console.log(chalk.cyan(`  ${pending} risky changed function(s) to review before the PR: run \`rigour review-task\`.\n`));
    } catch {
        // The hint must never fail a review.
    }
}

/** Anonymous usage (opt-in; TELEMETRY.md): counts and gate names only, never files or messages. */
async function reportUsage(result: ReviewResult, isDeep: boolean, options: ReviewOptions, ms: number): Promise<void> {
    const byGate = (findings: ReviewResult['findings']) => findings.reduce<Record<string, number>>((acc, f) => ({ ...acc, [f.id]: (acc[f.id] ?? 0) + 1 }), {});
    const deep = result.report?.stats.deep;
    await trackUsage('review_completed', {
        status: result.status,
        surface: options.githubSummary ? 'github' : options.ci ? 'ci' : options.json ? 'json' : 'terminal',
        changed_files: Object.keys(result.changedLines).length,
        findings_by_gate: byGate(result.findings),
        advisory_by_gate: byGate(result.advisory),
        dismissed_by_gate: result.dismissedByGate,
        context_findings: result.contextFindings.length,
        deep_tier: isDeep ? deep?.tier ?? 'unknown' : 'none',
        deep_routed: deep?.router?.routed,
        deep_tool_calls: deep?.tool_calls,
        deep_cost_bucket: costBucket(deep?.cost_usd),
        duration: durationBucket(ms),
    }, { version: process.env.RIGOUR_CLI_VERSION });
    await flushDailyUsage();
}

/** A deep run that did not happen overrides the changed-line verdict. */
function exitCodeFor(result: ReviewResult): number {
    if (result.status === 'ERROR') return EXIT_INTERNAL_ERROR;
    return result.status === 'PASS' ? EXIT_PASS : EXIT_FAIL;
}

function fail(error: any, options: ReviewOptions): never {
    const usage = error instanceof UsageError || error instanceof GitDiffError;
    const kind = error?.name === 'ZodError' ? 'CONFIG_ERROR' : usage ? 'INPUT_ERROR' : 'INTERNAL_ERROR';
    if (options.json) {
        console.log(JSON.stringify(kind === 'CONFIG_ERROR' ? { error: kind, details: error.issues } : { error: kind, message: error.message }));
    } else if (kind === 'CONFIG_ERROR') {
        console.error(chalk.red('Invalid rigour.yml configuration:'));
        error.issues.forEach((issue: any) => console.error(chalk.red(`  • ${issue.path.join('.')}: ${issue.message}`)));
    } else {
        console.error(chalk.red(`${usage ? 'Error' : 'Internal error'}: ${error.message}`));
    }
    process.exit(kind === 'INTERNAL_ERROR' ? EXIT_INTERNAL_ERROR : EXIT_CONFIG_ERROR);
}
