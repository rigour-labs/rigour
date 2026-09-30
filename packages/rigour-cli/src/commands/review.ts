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
import fs from 'fs-extra';
import path from 'path';
import chalk from 'chalk';
import yaml from 'yaml';
import { ConfigSchema, resolveDeepOptions, reviewChange, toReviewFinding, GitDiffError } from '@rigour-labs/core';
import type { Config, DeepOptions, ReviewResult } from '@rigour-labs/core';
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
    apiKey?: string;
    provider?: string;
    apiBaseUrl?: string;
    modelName?: string;
}

class UsageError extends Error {}

export async function reviewCommand(cwd: string, options: ReviewOptions = {}) {
    try {
        const config = await loadConfig(cwd, options);
        const diff = await readDiff(cwd, options);
        const isDeep = !!options.deep || !!options.pro || !!options.max || !!options.apiKey;
        if (!options.ci && !options.json && !options.githubSummary && isDeep) console.log(chalk.blue.bold('Deep analysis enabled.\n'));
        const result = await reviewChange({
            cwd, config, diff,
            source: options.base ? { mode: 'base', base: options.base } : { mode: 'working' },
            files: options.files ? options.files.split(',').map(f => f.trim()).filter(Boolean) : undefined,
            deep: isDeep ? deepOptions(cwd, options) : undefined,
        });
        await print(result, options);
        process.exit(exitCodeFor(result));
    } catch (error: any) {
        fail(error, options);
    }
}

/** rigour.yml, the file named by -c, or Rigour's defaults when the repository has none. */
async function loadConfig(cwd: string, options: ReviewOptions): Promise<Config> {
    const configPath = options.config ? path.resolve(cwd, options.config) : path.join(cwd, 'rigour.yml');
    if (await fs.pathExists(configPath)) return ConfigSchema.parse(yaml.parse(await fs.readFile(configPath, 'utf-8')));
    if (options.config) throw new UsageError(`Config file not found: ${configPath}`);
    return ConfigSchema.parse({ version: 1 });
}

/** --diff, else piped input, else undefined (core then takes the diff from git). */
async function readDiff(cwd: string, options: ReviewOptions): Promise<string | undefined> {
    if (options.diff) {
        const diffPath = path.resolve(cwd, options.diff);
        if (!(await fs.pathExists(diffPath))) throw new UsageError(`Diff file not found: ${diffPath}`);
        return fs.readFile(diffPath, 'utf-8');
    }
    const piped = await readStdin();
    return piped.trim() ? piped : undefined;
}

async function readStdin(): Promise<string> {
    if (process.stdin.isTTY) return '';
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
        provider: resolved.apiKey ? (resolved.provider || 'claude') : 'local',
        apiBaseUrl: resolved.apiBaseUrl,
        modelName: resolved.modelName,
    };
}

async function print(result: ReviewResult, options: ReviewOptions): Promise<void> {
    const summary = buildCiReviewSummary(result.findings, result.report?.failures.length ?? 0, result.changedLines,
        result.unlocated + result.fileFindings.length);
    if (result.deepError && !options.json) console.error(chalk.red(`Deep analysis did not run: ${result.deepError}`));
    if (options.json) return writeJson(result, summary);
    if (options.githubSummary) return void console.log(renderGithubSummary(summary));
    if (options.ci) return printCi(result);
    printHuman(result);
}

function writeJson(result: ReviewResult, summary: ReturnType<typeof buildCiReviewSummary>): Promise<void> {
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

function printHuman(result: ReviewResult): void {
    if (!result.report) {
        console.log(chalk.green('No changes to review.'));
        return;
    }
    if (result.findings.length === 0) {
        console.log(chalk.green.bold('\n✔ PASS — No quality issues on changed lines.\n'));
    } else {
        console.log(chalk.red.bold(`\n✘ FAIL — ${result.findings.length} issue(s) on changed lines.\n`));
        for (const f of result.findings) {
            console.log(`  ${chalk.red(`[${(f.severity || 'medium').toUpperCase()}]`)} ${f.files?.[0] || '?'}:${f.line ?? '?'}`);
            console.log(`    ${f.title}`);
            if (f.hint) console.log(chalk.cyan(`    → ${f.hint}`));
            console.log('');
        }
    }
    if (result.fileFindings.length) console.log(chalk.dim(`  ${result.fileFindings.length} file-level note(s) on changed files (see --json).`));
    if (result.excludedOutsideChangedLines) console.log(chalk.dim(`  (${result.excludedOutsideChangedLines} issue(s) on unchanged lines were excluded)\n`));
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
