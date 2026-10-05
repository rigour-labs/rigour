/**
 * `rigour review --reviewer`: the fresh reviewer (core review/reviewer.ts) after the rules, as a
 * person reads it: every point of the previous human review, open or resolved, then the new
 * blocking issues. No verdict is never a pass.
 */
import chalk from 'chalk';
import { branchBase, runReviewer, reviewerBlocks, type Config, type ReviewerResult } from '@rigour-labs/core';

/** The base a branch review runs against: the one named, else where the branch left main. */
export function reviewerBase(cwd: string, named: string | undefined): string | undefined {
    return named ?? branchBase(cwd)?.mainRef.replace(/^refs\/(remotes\/|heads\/)/, '');
}

export async function reviewerFor(cwd: string, base: string | undefined, config: Config): Promise<ReviewerResult> {
    if (!base) return { error: 'no base to review against: pass --base, or fetch the main branch', cached: false };
    return runReviewer(cwd, base, config);
}

export function printReviewer(result: ReviewerResult): void {
    console.log(chalk.bold('\n  Reviewer') + chalk.dim(result.previousReview ? `  (previous review: ${result.previousReview})` : '  (no previous human review)'));
    if (!result.verdict) {
        console.log(chalk.red(`  No verdict: ${result.error}. Treated as a fail.`));
        return;
    }
    for (const p of result.verdict.prior_points) {
        console.log(`  ${p.resolved ? chalk.green('resolved') : chalk.red('OPEN    ')} ${p.point}${p.evidence ? chalk.dim(`\n           ${p.evidence}`) : ''}`);
    }
    for (const b of result.verdict.blocking) console.log(`  ${chalk.red('blocking')} ${b.file}${b.line ? `:${b.line}` : ''} ${b.issue}${b.why ? chalk.dim(`\n           ${b.why}`) : ''}`);
    for (const n of result.verdict.non_blocking) console.log(chalk.dim(`  note     ${n.file} ${n.issue}`));
    const open = result.verdict.prior_points.filter(p => !p.resolved).length;
    console.log(`  ${open} previous point(s) open, ${result.verdict.blocking.length} blocking${result.cached ? chalk.dim(' (cached for this commit)') : ''}\n`);
}

export function reviewerJson(result: ReviewerResult): Record<string, unknown> {
    return { blocks: reviewerBlocks(result), cached: result.cached, previous_review: result.previousReview ?? null, ...(result.verdict ?? { error: result.error }) };
}
