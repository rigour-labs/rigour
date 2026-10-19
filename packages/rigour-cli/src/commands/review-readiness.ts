/**
 * The readiness verdict in `rigour review` (core review/readiness.ts): "Technically ready: … · Product ready: …" and
 * the coverage table, in the terminal, the CI text, `--json` and `--github-summary`. It reads the review; it never
 * changes the status, the exit code or what blocks.
 */
import chalk from 'chalk';
import { coverageText, readinessLine, readinessMarkdown, type Readiness } from '@rigour-labs/core';

/** The terminal's width, less a margin; CI logs and pipes have none, and read 100 columns. */
function terminalWidth(): number {
    return Math.max(60, (process.stdout.columns || 102) - 2);
}

export function printReadiness(r: Readiness, color = true, width = terminalWidth()): void {
    console.log(color ? chalk.bold(readinessLine(r)) : readinessLine(r));
    for (const line of coverageText(r, width - 2)) console.log(color ? chalk.dim(`  ${line}`) : `  ${line}`);
    console.log('');
}

export function readinessSummary(r: Readiness): string {
    return ['', ...readinessMarkdown(r)].join('\n');
}
