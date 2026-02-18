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


export function printClosing(cinematic: boolean): void {
    const divider = chalk.bold.cyan('━'.repeat(50));
    console.log(divider);
    console.log(chalk.bold('What Rigour does:'));
    console.log(chalk.dim('  Catches AI drift (hallucinated imports, unhandled promises)'));
    console.log(chalk.dim('  Blocks security issues (hardcoded keys, injection patterns)'));
    console.log(chalk.dim('  Enforces structure (file size, complexity, documentation)'));
    console.log(chalk.dim('  Generates audit-ready evidence (scores, trends, reports)'));
    console.log(chalk.dim('  Real-time hooks for Claude, Cursor, Cline, Windsurf'));
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

