/**
 * The readiness verdict in `rigour review` (core review/readiness.ts): "Technically ready: … · Product ready: …" and
 * the coverage table, in the terminal, the CI text, `--json` and `--github-summary`. It reads the review; it never
 * changes the status, the exit code or what blocks.
 */
import chalk from 'chalk';
import { coverageText, readinessLine, readinessMarkdown, type Readiness } from '@rigour-labs/core';

export function printReadiness(r: Readiness, color = true): void {
    const paint = color ? (text: string) => chalk.bold(text) : (text: string) => text;
    console.log(paint(readinessLine(r)));
    for (const line of coverageText(r)) console.log(color ? chalk.dim(`  ${line}`) : `  ${line}`);
    console.log('');
}

export function readinessSummary(r: Readiness): string {
    return ['', ...readinessMarkdown(r)].join('\n');
}
