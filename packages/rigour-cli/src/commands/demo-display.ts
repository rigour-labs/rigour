import chalk from 'chalk';
import type { DemoOptions } from './demo-helpers.js';
import { pause, typewrite, getMultiplier, sleep } from './demo-helpers.js';

// ── Simulated code writing ──────────────────────────────────────────

export async function simulateCodeWrite(
    filename: string,
    lines: string[],
    options: DemoOptions
): Promise<void> {
    const isCinematic = !!options.cinematic;
    const lineDelay = isCinematic ? 40 * getMultiplier(options) : 0;

    console.log(chalk.dim(`\n  ${chalk.white('▸')} Writing ${chalk.cyan(filename)}...`));
    if (isCinematic) {
        await pause(200, options);
    }

    for (const line of lines) {
        if (isCinematic) {
            process.stdout.write(chalk.dim(`    ${line}\n`));
            await sleep(lineDelay);
        }
    }

    if (!isCinematic) {
        const preview = lines.slice(0, 3).join('\n    ');
        console.log(chalk.dim(`    ${preview}`));
        if (lines.length > 3) {
            console.log(chalk.dim(`    ... (${lines.length} lines)`));
        }
    }
}

// ── Hook simulation ─────────────────────────────────────────────────

export async function simulateHookCatch(
    gate: string,
    file: string,
    message: string,
    severity: string,
    options: DemoOptions
): Promise<void> {
    if (options.cinematic) {
        await pause(300, options);
    }

    const sevColor = severity === 'critical' ? chalk.red.bold
        : severity === 'high' ? chalk.red
        : chalk.yellow;

    const hookPrefix = chalk.magenta.bold('[rigour/hook]');
    const sevLabel = sevColor(severity.toUpperCase());
    const gateLabel = chalk.red(`[${gate}]`);

    console.log(`  ${hookPrefix} ${sevLabel} ${gateLabel} ${chalk.white(file)}`);
    console.log(`    ${chalk.dim('→')} ${message}`);

    if (options.cinematic) {
        await pause(400, options);
    }
}

// ── ASCII score bar ─────────────────────────────────────────────────

export function renderScoreBar(score: number, label: string, width = 30): string {
    const filled = Math.round((score / 100) * width);
    const empty = width - filled;
    const color = score >= 80 ? chalk.green : score >= 50 ? chalk.yellow : chalk.red;
    const bar = color('█'.repeat(filled)) + chalk.dim('░'.repeat(empty));
    return `  ${label.padEnd(14)} ${bar} ${color.bold(`${score}/100`)}`;
}

// ── ASCII trend chart ───────────────────────────────────────────────

export function renderTrendChart(scores: number[]): string {
    const height = 8;
    const lines: string[] = [];
    const maxScore = 100;

    lines.push(chalk.dim('  Score Trend:'));
    for (let row = height; row >= 0; row--) {
        const threshold = (row / height) * maxScore;
        let line = chalk.dim(String(Math.round(threshold)).padStart(3) + ' │');
        for (const score of scores) {
            if (score >= threshold) {
                const color = score >= 80 ? chalk.green : score >= 50 ? chalk.yellow : chalk.red;
                line += color(' ██');
            } else {
                line += '   ';
            }
        }
        lines.push(line);
    }
    lines.push(chalk.dim('    └' + '───'.repeat(scores.length)));
    const labels = scores.map((_, i) => ` R${i + 1}`);
    lines.push(chalk.dim('     ' + labels.join('')));

    return lines.join('\n');
}


// ── Banner ───────────────────────────────────────────────────────────

export function printBanner(cinematic: boolean): void {
    const banner = chalk.bold.cyan(`
   ____  _
  / __ \\(_)____ ___  __  __ _____
 / /_/ // // __ \`/ / / / / // ___/
/ _, _// // /_/ // /_/ / / // /
/_/ |_|/_/ \\__, / \\__,_/_/ /_/
          /____/
    `);
    console.log(banner);
}

// ── Planted issues (non-cinematic) ──────────────────────────────────

export function printPlantedIssues(): void {
    console.log(chalk.bold.yellow('Planted issues:'));
    console.log(chalk.dim('  1. src/auth.ts         — Hardcoded API key (security)'));
    console.log(chalk.dim('  2. src/api-handler.ts  — Unhandled promise (AI drift)'));
    console.log(chalk.dim('  3. src/data-loader.ts  — Hallucinated import (AI drift)'));
    console.log(chalk.dim('  4. src/utils.ts        — TODO marker left by AI'));
    console.log(chalk.dim('  5. src/god-file.ts     — 350+ lines (structural)'));
    console.log('');
}

// ── Hooks demo: simulate AI agent → hook catches ────────────────────

// ── Closing section ─────────────────────────────────────────────────


export function displayGateResults(report: any, cinematic: boolean): void {
    const stats = report.stats;

    if (report.status === 'FAIL') {
        console.log(chalk.red.bold('✘ FAIL — Quality gate violations found.\n'));

        // Score bars
        if (stats.score !== undefined) {
            console.log(renderScoreBar(stats.score, 'Overall'));
        }
        if (stats.ai_health_score !== undefined) {
            console.log(renderScoreBar(stats.ai_health_score, 'AI Health'));
        }
        if (stats.structural_score !== undefined) {
            console.log(renderScoreBar(stats.structural_score, 'Structural'));
        }
        console.log('');

        // Severity breakdown
        printSeverityBreakdown(stats);

        // Violations list
        for (const failure of report.failures) {
            printFailure(failure);
        }
        console.log('');
    } else {
        console.log(chalk.green.bold('✔ PASS — All quality gates satisfied.\n'));
    }

    // Provenance breakdown
    if (stats.provenance_breakdown) {
        const parts = Object.entries(stats.provenance_breakdown)
            .filter(([, count]) => (count as number) > 0)
            .map(([prov, count]) => chalk.dim(`${prov}: ${count}`));
        if (parts.length > 0) {
            console.log(chalk.bold('  Provenance: ') + parts.join(' | '));
            console.log('');
        }
    }

    console.log(chalk.dim(`Finished in ${stats.duration_ms}ms\n`));
}

export function printSeverityBreakdown(stats: any): void {
    if (!stats.severity_breakdown) {
        return;
    }
    const parts = Object.entries(stats.severity_breakdown)
        .filter(([, count]) => (count as number) > 0)
        .map(([sev, count]) => {
            const color = sev === 'critical' ? chalk.red.bold
                : sev === 'high' ? chalk.red
                : sev === 'medium' ? chalk.yellow
                : chalk.dim;
            return color(`${sev}: ${count}`);
        });
    if (parts.length > 0) {
        console.log('Severity: ' + parts.join(', ') + '\n');
    }
}

export function printFailure(failure: any): void {
    const sevLabel = failure.severity === 'critical' ? chalk.red.bold('CRIT')
        : failure.severity === 'high' ? chalk.red('HIGH')
        : failure.severity === 'medium' ? chalk.yellow('MED ')
        : chalk.dim('LOW ');
    const prov = failure.provenance ? chalk.dim(`[${failure.provenance}]`) : '';
    console.log(`  ${sevLabel} ${prov} ${chalk.red(`[${failure.id}]`)} ${failure.title}`);
    if (failure.hint) {
        console.log(chalk.cyan(`        ${failure.hint}`));
    }
}


// ── Drift Detection Summary (for demo/Nikhil) ──────────────────────

export function displayDriftSummary(): void {
    console.log(chalk.bold.cyan('\n  ── v5.1 Drift Detection Engine ──\n'));
    console.log(chalk.white('  Seven production-grade detection systems:\n'));

    console.log(chalk.bold('  1. EWMA Checkpoint Monitoring'));
    console.log(chalk.dim('     Before: Linear regression on 5 points (one outlier = broken)'));
    console.log(chalk.green('     After:  EWMA (α=0.3) — 70% history, 30% new → noise-resistant'));
    console.log(chalk.dim('     Detects: sudden drops AND gradual decline separately\n'));

    console.log(chalk.bold('  2. Z-Score Adaptive Thresholds'));
    console.log(chalk.dim('     Before: Moving window delta (100→108 = "degrading")'));
    console.log(chalk.green('     After:  Z-score normalization — size-independent anomaly detection'));
    console.log(chalk.dim('     Per-provenance: AI drift vs structural vs security tracked independently\n'));

    console.log(chalk.bold('  3. Three-Pass Duplicate Detection'));
    console.log(chalk.dim('     Pass 1: MD5 hash → exact duplicates (O(n), <10ms)'));
    console.log(chalk.dim('     Pass 2: Jaccard on tree-sitter AST node multisets → structural near-duplicates'));
    console.log(chalk.green('     Pass 3: Semantic embedding (all-MiniLM-L6-v2, 384D) → intent-level duplicates'));
    console.log(chalk.dim('     Catches: .find() vs .filter()[0] — same intent, different AST\n'));

    console.log(chalk.bold('  4. Temporal Drift Engine'));
    console.log(chalk.dim('     Cross-session trend analysis from SQLite brain'));
    console.log(chalk.green('     Per-provenance EWMA streams + monthly rollups + anomaly detection'));
    console.log(chalk.dim('     Answers: "Is AI getting worse?" independently from "Is code quality dropping?"\n'));

    console.log(chalk.bold('  5. Dependency Bloat Detection'));
    console.log(chalk.dim('     Before: Only checked forbidden package list'));
    console.log(chalk.green('     After:  Unused deps + heavy alternatives + duplicate purpose detection'));
    console.log(chalk.dim('     Catches: axios AND got both installed (AI sessions chose different HTTP clients)\n'));

    console.log(chalk.bold('  6. Style Drift Detection'));
    console.log(chalk.dim('     Before: No style enforcement beyond linters'));
    console.log(chalk.green('     After:  Fingerprint naming, error handling, import style, quotes → compare to baseline'));
    console.log(chalk.dim('     Catches: AI switching from camelCase to snake_case mid-project\n'));

    console.log(chalk.bold('  7. Logic Drift Foundation'));
    console.log(chalk.dim('     Before: No detection of subtle logic changes'));
    console.log(chalk.green('     After:  Tracks comparison operators, branch counts, return counts per function'));
    console.log(chalk.dim('     Catches: >= silently became > (off-by-one), return statements added/removed\n'));
}

export function printClosing(cinematic: boolean): void {
    const divider = chalk.bold.cyan('━'.repeat(50));

    // Show drift detection summary in cinematic mode
    if (cinematic) {
        displayDriftSummary();
    }

    console.log(divider);
    console.log(chalk.bold('What Rigour does (27+ gates):'));
    console.log(chalk.dim('  Catches AI drift (hallucinated imports, duplicates, logic mutations)'));
    console.log(chalk.dim('  Blocks security issues (hardcoded keys, injection patterns, DLP)'));
    console.log(chalk.dim('  Enforces structure (file size, complexity, documentation)'));
    console.log(chalk.dim('  Detects dependency bloat (unused, heavy, duplicate purpose)'));
    console.log(chalk.dim('  Monitors style drift (naming, error handling, imports)'));
    console.log(chalk.dim('  Tracks logic mutations (operator changes, branch count shifts)'));
    console.log(chalk.dim('  Generates audit-ready evidence (scores, trends, reports)'));
    console.log(chalk.dim('  Real-time hooks for Claude, Cursor, Cline, Windsurf'));
    console.log(chalk.dim('  Three-pass duplication: MD5 → AST Jaccard → Semantic Embedding'));
    console.log(chalk.dim('  EWMA + Z-score + temporal drift engine (v5.1)'));
    console.log(divider);
    console.log('');

    if (cinematic) {
        console.log(chalk.bold('Peer-reviewed research:'));
        console.log(chalk.white('  Deterministic Quality Gates for AI-Generated Code'));
        console.log(chalk.dim('  https://zenodo.org/records/18673564'));
        console.log('');
    }

    console.log(chalk.bold('Get started:'));
    console.log(chalk.white('  $ npx @rigour-labs/cli init'));
    console.log(chalk.white('  $ npx @rigour-labs/cli check'));
    console.log(chalk.white('  $ npx @rigour-labs/cli hooks init'));
    console.log('');
    console.log(chalk.dim('GitHub: https://github.com/rigour-labs/rigour'));
    console.log(chalk.dim('Docs:   https://docs.rigour.run'));
    console.log(chalk.dim('Paper:  https://zenodo.org/records/18673564\n'));

    console.log(chalk.dim.italic(
        'If this saved you from a bad commit, star the repo ⭐'
    ));
}

