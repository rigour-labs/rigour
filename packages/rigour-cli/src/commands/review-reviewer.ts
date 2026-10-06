/**
 * `rigour review --reviewer`: the reviewer (core review/reviewer.ts) after the rules, as a person
 * reads it: every open item with file:line and who found it, what was resolved since the last
 * verdict, and the human's non-blocking points to answer in the reply. No verdict is never a pass.
 * `--full` runs two vendors with the verdicts merged: the step before asking a person to look.
 * `--status` shows what the background reviewer has done for the branch.
 */
import chalk from 'chalk';
import { branchBase, itemLine, reviewStatus, runReviewer, type Config, type ReviewerResult, type ReviewStatus } from '@rigour-labs/core';

/** The base a branch review runs against: the one named, else where the branch left main. */
export function reviewerBase(cwd: string, named: string | undefined): string | undefined {
    return named ?? branchBase(cwd)?.mainRef.replace(/^refs\/(remotes\/|heads\/)/, '');
}

export async function reviewerFor(cwd: string, base: string | undefined, config: Config, full: boolean): Promise<ReviewerResult> {
    if (!base) return { outcome: 'unavailable', items: [], unverified: [], resolved: [], answerInReply: [], reason: 'no base to review against: pass --base, or fetch the main branch', reviewers: [], cached: false };
    return runReviewer(cwd, base, config, undefined, undefined, { trigger: 'review', full });
}

export function printReviewer(result: ReviewerResult): void {
    const who = result.reviewers.length ? result.reviewers.join(' + ') : 'no reviewer';
    console.log(chalk.bold('\n  Reviewer') + chalk.dim(`  ${who}${result.scope ? `, ${result.scope}${result.why ? ` (${result.why})` : ''}` : ''}${result.previousReview ? `; previous review: ${result.previousReview}` : '; no previous human review'}`));
    if (result.outcome === 'unavailable') {
        console.log(chalk.red(`  No verdict: ${result.reason}. Treated as a fail.`));
        return;
    }
    if (result.outcome === 'skipped') {
        console.log(chalk.yellow(`  Skipped: ${result.reason}`));
        return;
    }
    for (const { item, evidence } of result.resolved) console.log(chalk.green(`  resolved  ${item.file ?? ''}${item.line ? `:${item.line}` : ''} ${item.issue.slice(0, 120)}`) + chalk.dim(`\n            ${evidence}`));
    for (const item of result.items) console.log(`  ${chalk.red('OPEN')}  ${itemLine(item)}`);
    for (const item of result.unverified) console.log(chalk.dim(`  unverified (names code the checkout does not have)  ${itemLine(item)}`));
    for (const point of result.answerInReply) console.log(chalk.dim(`  answer in the reply  ${point.point}${point.evidence ? `\n            ${point.evidence}` : ''}`));
    const cost = result.costUsd !== undefined ? `, $${result.costUsd.toFixed(2)}` : '';
    console.log(`  ${result.items.length} open item(s)${result.cached ? chalk.dim(' (cached for this commit)') : cost}\n`);
}

export function reviewerJson(result: ReviewerResult): Record<string, unknown> {
    return {
        outcome: result.outcome,
        blocks: result.outcome === 'findings' || result.outcome === 'unavailable',
        reason: result.reason ?? null,
        reviewers: result.reviewers,
        scope: result.scope ?? null,
        items: result.items,
        unverified: result.unverified,
        resolved: result.resolved,
        answer_in_reply: result.answerInReply,
        cost_usd: result.costUsd ?? null,
        cached: result.cached,
        previous_review: result.previousReview ?? null,
        pr: result.pr ?? null,
    };
}

export async function printStatus(cwd: string, json: boolean): Promise<number> {
    const branch = branchBase(cwd);
    const name = branch?.onMain === false ? currentBranch(cwd) : currentBranch(cwd);
    const status: ReviewStatus | undefined = await reviewStatus(cwd, name);
    if (!status) {
        console.error(chalk.red('not a repository'));
        return 2;
    }
    if (json) {
        console.log(JSON.stringify(status, null, 2));
        return 0;
    }
    console.log(chalk.bold(`  Reviewer on ${status.branch}`));
    if (status.running) console.log(chalk.yellow(`  running for ${status.running.head.slice(0, 9)} (pid ${status.running.pid})${status.log ? chalk.dim(`, log: ${status.log}`) : ''}`));
    if (status.last) {
        console.log(`  last verdict: ${status.last.head.slice(0, 9)}, ${status.last.mode}, ${status.last.at}: ${status.last.open.length ? chalk.red(`${status.last.open.length} open item(s)`) : chalk.green('passed')}`);
        for (const item of status.last.open) console.log(`  ${chalk.red('OPEN')}  ${itemLine(item)}`);
    } else if (!status.running) console.log(chalk.dim('  no verdict yet: push with review.reviewer.enabled, or run `rigour review --reviewer`'));
    return status.last?.open.length ? 1 : 0;
}

function currentBranch(cwd: string): string {
    const { execFileSync } = require('child_process') as typeof import('child_process');
    try {
        return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
    } catch {
        return 'HEAD';
    }
}
