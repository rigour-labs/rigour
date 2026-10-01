/**
 * The pre-PR review without a model key: Rigour picks the risky changed
 * functions and says what to check; the developer (or their agent) checks
 * and acknowledges them. `review-export` writes the shareable ledger that
 * lets the PR bot skip what was already reviewed.
 */
import chalk from 'chalk';
import { acknowledgeReview, buildReviewTask, diffFromGit, exportReviewed, type ReviewTask } from '@rigour-labs/core';
import { loadConfig } from './review-config.js';

export interface ReviewTaskOptions {
    base?: string;
    json?: boolean;
    config?: string;
}

export async function reviewTaskCommand(cwd: string, options: ReviewTaskOptions = {}): Promise<void> {
    const config = await loadConfig(cwd, options);
    const diff = diffFromGit(cwd, options.base ? { mode: 'base', base: options.base } : { mode: 'working' });
    const task = buildReviewTask(cwd, diff, config.gates.deep?.router);
    if (options.json) {
        console.log(JSON.stringify({ items: task.items, already_reviewed: task.alreadyReviewed, instructions: task.instructions }, null, 2));
        return;
    }
    printTask(task);
}

export function printTask(task: ReviewTask): void {
    if (task.items.length === 0) {
        console.log(chalk.green(`✔ No risky changed function waiting for review${task.alreadyReviewed ? ` (${task.alreadyReviewed} already reviewed)` : ''}.`));
        return;
    }
    console.log(chalk.bold(`\n${task.items.length} risky changed function(s) to review before the PR:\n`));
    for (const item of task.items) {
        console.log(`  ${chalk.yellow(`${item.file}:${item.start}`)} ${chalk.bold(item.function)}`);
        for (const question of item.questions) console.log(chalk.dim(`    - ${question}`));
    }
    console.log(chalk.cyan('\n  When checked: rigour review-ack <file> <function> --verdict no_issue|fixed --note "what you checked"\n'));
}

export function reviewAckCommand(cwd: string, file: string, fn: string, options: { verdict?: string; note?: string }): void {
    const result = acknowledgeReview(cwd, { file, function: fn, verdict: options.verdict ?? '', note: options.note ?? '', reviewer: 'human' });
    if (!result.ok) {
        console.error(chalk.red(`Not recorded: ${result.error}`));
        process.exitCode = 1;
        return;
    }
    console.log(chalk.green(`✔ Recorded: ${result.entry.file} ${result.entry.function} (${result.entry.verdict})`));
}

export function reviewExportCommand(cwd: string): void {
    const result = exportReviewed(cwd);
    console.log(chalk.green(`✔ Wrote ${result.path} (${result.entries} reviewed function(s); hashes and verdicts only, no code).`));
    console.log(chalk.dim('  Commit it to let the Rigour PR bot skip functions reviewed before the PR.'));
}
