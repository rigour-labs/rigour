/**
 * `rigour review --reviewer`: the reviewer (core review/reviewer.ts) after the rules, as a person
 * reads it: every open item with file:line and who found it, what was resolved since the last
 * verdict, and the human's non-blocking points to answer in the reply. No verdict is never a pass.
 * `--full` runs two vendors with the verdicts merged: the step before asking a person to look.
 * `--status` shows what the background reviewer has done for the branch.
 */
import chalk from 'chalk';
import { execFileSync } from 'child_process';
import { branchBase, itemLine, reviewerInputs, reviewStatus, runReviewer, type Config, type ReviewerResult, type ReviewResult, type ReviewStatus, type RunChoice } from '@rigour-labs/core';

/** The base a branch review runs against: the one named, else where the branch left main. */
export function reviewerBase(cwd: string, named: string | undefined): string | undefined {
    return named ?? branchBase(cwd)?.mainRef.replace(/^refs\/(remotes\/|heads\/)/, '');
}

export async function reviewerFor(cwd: string, base: string | undefined, config: Config, full: boolean, choice: RunChoice, review: ReviewResult, goal?: boolean, orchestrator?: boolean): Promise<ReviewerResult> {
    if (!base) return { outcome: 'unavailable', items: [], unverified: [], resolved: [], answerInReply: [], notes: [], advisory: [], disputed: [], dropped: [], dismissed: [], reason: 'no base to review against: pass --base, or fetch the main branch', reviewers: [], cached: false };
    return runReviewer(cwd, base, config, undefined, undefined, { trigger: 'review', full, choice, ...(goal !== undefined ? { goal } : {}), ...(orchestrator !== undefined ? { orchestrator } : {}), ...reviewerInputs(review) });
}

/** Verified should-fixes shown in full before the rest fold into a count. */
const ADVISORY_SHOWN = 5;

export function printReviewer(result: ReviewerResult, options: { notes?: boolean } = {}): void {
    const who = result.reviewers.length ? result.reviewers.join(' + ') : 'no reviewer';
    console.log(chalk.bold('\n  Reviewer') + chalk.dim(`  ${who}${result.scope ? `, ${result.scope}${result.why ? ` (${result.why})` : ''}` : ''}${result.previousReview ? `; previous review: ${result.previousReview}` : '; no previous human review'}`));
    printMode(result);
    if (result.outcome === 'unavailable') {
        console.log(chalk.red(`  No verdict: ${result.reason}. Treated as a fail.`));
        return;
    }
    if (result.outcome === 'skipped') {
        console.log(chalk.yellow(`  Skipped: ${result.reason}`));
        return;
    }
    for (const { item, evidence } of result.resolved) console.log(chalk.green(`  resolved  ${item.file ?? ''}${item.line ? `:${item.line}` : ''} ${item.issue.slice(0, 120)}`) + chalk.dim(`\n            ${evidence}`));
    for (const item of result.items) {
        console.log(`  ${chalk.red('OPEN')}  ${itemLine(item)}`);
        if (item.kind !== 'prior' && result.dismissable) console.log(chalk.dim(`        not a bug? rigour dismiss ${item.id} --reason "…"`));
    }
    // What is shown gets the same discipline as what blocks: blocks in full, verified should-fixes capped, the rest one count.
    const shown = result.advisory.slice(0, options.notes ? undefined : ADVISORY_SHOWN);
    for (const item of shown) console.log(chalk.yellow(`  should fix (verified, never blocks)  ${itemLine(item)}`));
    for (const point of result.answerInReply) console.log(chalk.dim(`  answer in the reply  ${point.point}${point.evidence ? `\n            ${point.evidence}` : ''}`));
    const folded = [
        [result.advisory.length - shown.length, 'more should-fix'], [result.notes.length, 'working note'], [result.disputed.length, 'disputed'],
        [result.unverified.length, 'unverified'], [result.dismissed.length, 'dismissed earlier'], [result.dropped.length, 'refuted by the other judges'],
    ].filter(([n]) => (n as number) > 0) as Array<[number, string]>;
    if (options.notes) {
        for (const item of result.disputed) console.log(chalk.dim(`  disputed, never blocks (no majority)  ${itemLine(item)}`));
        for (const item of result.notes) console.log(chalk.dim(`  note, never blocks (a working step, or no wrong outcome named)  ${itemLine(item)}`));
        for (const item of result.dismissed) console.log(chalk.dim(`  dismissed earlier as not a bug  ${itemLine(item)}`));
        for (const item of result.unverified) console.log(chalk.dim(`  unverified (a quote or a file the checkout does not have)  ${itemLine(item)}`));
    } else if (folded.length) {
        console.log(chalk.dim(`  Also seen, never blocking: ${folded.map(([n, what]) => `${n} ${what}${n === 1 || what.startsWith('more') || what === 'disputed' || what === 'unverified' ? '' : 's'}`).join(', ')} (rigour review --reviewer --notes lists them)`));
    }
    if (result.rules?.checked) console.log(chalk.dim(`  repository rules answered: ${result.rules.checked} (${result.rules.broken} broken, ${result.rules.followed} followed, ${result.rules.notApplicable} not applicable)`));
    if (result.record && result.recordPath) console.log(chalk.dim(`  record: ${result.recordPath} (integrity ${result.record.integrity.slice(0, 16)})`));
    const tokens = result.tokens ? `, ${(result.tokens.input + result.tokens.output).toLocaleString('en-US')} tokens` : '';
    // What every run of this review cost, failed ones included (the verdict's judges alone would under-count it).
    const spent = result.spentUsd ?? result.costUsd;
    const cost = `${spent !== undefined ? `, $${spent.toFixed(2)}` : ''}${tokens}`;
    console.log(`  ${result.items.length} open item(s)${result.cached ? chalk.dim(' (cached for this commit)') : cost}\n`);
}

/** Which mode ran, against which was asked, and why: a panel never shrinks to one judge silently. */
function printMode(result: ReviewerResult): void {
    const mode = result.mode;
    if (!mode) return;
    if (mode.asked !== mode.ran || mode.degraded || mode.escalation) {
        const why = [mode.degraded, mode.escalation, mode.specialists?.fallback].filter(Boolean).join('; ');
        console.log(chalk.yellow(`  ${mode.asked} asked (${mode.source}), ${mode.ran} ran${why ? `: ${why}` : ''}`));
    }
    for (const line of mode.refused ?? []) console.log(chalk.yellow(`  ${line}`));
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
        notes: result.notes,
        advisory: result.advisory,
        shown: { blocking: result.items.length, should_fix: Math.min(result.advisory.length, ADVISORY_SHOWN), folded: result.advisory.length - Math.min(result.advisory.length, ADVISORY_SHOWN) + result.notes.length + result.disputed.length + result.unverified.length + result.dismissed.length + result.dropped.length },
        disputed: result.disputed,
        dropped: result.dropped,
        dismissed: result.dismissed,
        mode: result.mode ?? null,
        panel: result.panel ?? null,
        // The verdict's judges, as reported; kept for compatibility. spent_usd is every run, and 0 for a cached verdict.
        cost_usd: result.costUsd ?? null,
        spent_usd: result.spentUsd ?? 0,
        tokens: result.tokens ?? null,
        cached: result.cached,
        previous_review: result.previousReview ?? null,
        record: result.record ?? null,
        pr: result.pr ?? null,
    };
}

export async function printStatus(cwd: string, json: boolean): Promise<number> {
    const status: ReviewStatus | undefined = await reviewStatus(cwd, currentBranch(cwd));
    if (!status) {
        console.error(chalk.red('not a repository'));
        return 2;
    }
    if (json) {
        console.log(JSON.stringify(status, null, 2));
        return 0;
    }
    console.log(chalk.bold(`  Reviewer on ${status.branch}`) + chalk.dim(`  today: ${status.today.runs} agent run(s)${status.today.usd ? `, $${status.today.usd.toFixed(2)} reported` : ''}`));
    if (status.running) console.log(chalk.yellow(`  running for ${status.running.head.slice(0, 9)} (pid ${status.running.pid})${status.log ? chalk.dim(`, log: ${status.log}`) : ''}`));
    if (status.attempt) console.log(chalk.yellow(`  last attempt on ${status.attempt.head.slice(0, 9)}, ${status.attempt.at}: ${status.attempt.outcome === 'skipped' ? 'skipped' : 'could not run'}: ${status.attempt.reason}`));
    if (status.last) {
        console.log(`  last verdict: ${status.last.head.slice(0, 9)}, ${status.last.mode === 'delta' ? 'new commits only' : 'whole branch'}, ${status.last.at}: ${status.last.open.length ? chalk.red(`${status.last.open.length} open item(s)`) : chalk.green('passed')}`);
        const ran = status.last.ran;
        if (ran) console.log(chalk.dim(`  judges: ${ran.ran} ran (${ran.asked} asked, ${ran.source})${ran.degraded ? `: ${ran.degraded}` : ''}${ran.escalation ? `; ${ran.escalation}` : ''}`));
        for (const item of status.last.open) console.log(`  ${chalk.red('OPEN')}  ${itemLine(item)}`);
        for (const item of status.last.disputed) console.log(chalk.yellow(`  disputed, never blocks  ${itemLine(item)}`));
    } else if (!status.running && !status.attempt) console.log(chalk.dim('  no verdict yet: push with review.reviewer.enabled, or run `rigour review --reviewer`'));
    return status.last?.open.length ? 1 : 0;
}

function currentBranch(cwd: string): string {
    try {
        return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
    } catch {
        return 'HEAD';
    }
}
