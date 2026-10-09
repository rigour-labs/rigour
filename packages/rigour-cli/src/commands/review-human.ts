/**
 * `rigour review` as a person reads it. It answers "is this worth my time?" in a few seconds:
 * what was reviewed, then the verdict on its own line (things to fix, nothing to fix, or not
 * finished with the one command that finishes it), at most five findings each with where, what
 * and the fix, one quiet line each for what was seen but never blocks, and one next step. The
 * receipt of agent reviews appears only once there are agent reviews to report (or --receipt);
 * on a first run it is all zeros and reads like a list of problems. JSON, CI and the GitHub
 * summary keep their own output (review.ts).
 */
import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import { findingKey, type QualityReceipt, type ReviewResult } from '@rigour-labs/core';
import { enabledHere } from './personal.js';
import { printReceipt } from './review-receipt.js';

const SHOWN = 5;

export interface HumanContext {
    cwd: string;
    /** What was reviewed: `this branch against main`, `your uncommitted changes`, `the diff`. */
    scope: string;
    commits?: number;
    ms: number;
    receipt: QualityReceipt | null;
    all?: boolean;
    notes?: boolean;
    showReceipt?: boolean;
}

export function printHuman(result: ReviewResult, context: HumanContext): void {
    if (!result.report) {
        console.log(chalk.green('No changes to review.'));
        return;
    }
    const files = Object.keys(result.changedLines).length;
    const commits = context.commits ? `${context.commits} commit${context.commits === 1 ? '' : 's'}, ` : '';
    console.log(`\nRigour reviewed ${context.scope}: ${commits}${files} file${files === 1 ? '' : 's'}, ${seconds(context.ms)}.\n`);

    const unfinished = notFinished(result, context.cwd);
    if (result.findings.length) printFindings(result, !!context.all);
    if (unfinished) console.log(chalk.yellow.bold(`${result.findings.length ? '⚠ Also not finished' : '⚠ Not finished'}: ${unfinished.why}`) + `\n  ${unfinished.fix}${result.findings.length ? '' : ' Everything else found nothing.'}\n`);
    else if (!result.findings.length) console.log(chalk.green.bold('✔ Nothing to fix in what this changed.\n'));

    printQuietLines(result, !!context.notes);
    const reviewedByAgents = !!context.receipt && (context.receipt.reviewed > 0 || context.receipt.changedSinceReview > 0);
    if (context.receipt && (context.showReceipt || reviewedByAgents)) printReceipt(context.receipt);
    if (!setUp(context.cwd)) {
        console.log(chalk.cyan('Next: rigour setup checks this while your agent works and before every push.'));
        console.log(chalk.cyan('      Nothing goes in your repository.\n'));
    }
}

function printFindings(result: ReviewResult, all: boolean): void {
    const count = result.findings.length;
    console.log(chalk.red.bold(`✘ ${count} thing${count === 1 ? '' : 's'} to fix before this is ready\n`));
    for (const f of all ? result.findings : result.findings.slice(0, SHOWN)) {
        console.log(`  ${chalk.bold(`${f.files?.[0] || '?'}:${f.line ?? '?'}`)}  ${f.title}`);
        if (f.hint) console.log(chalk.cyan(`    → ${f.hint}`));
        console.log(chalk.dim(`    not a bug? rigour dismiss ${findingKey(f)} --reason "…"`));
    }
    if (!all && count > SHOWN) console.log(chalk.dim(`\n  …and ${count - SHOWN} more: rigour review --all`));
    console.log(chalk.dim('\n  Wrong? Dismiss it once and it never comes back.\n'));
}

/** One line each, in plain words, for what was seen and never blocks. */
function printQuietLines(result: ReviewResult, notes: boolean): void {
    const lines: string[] = [];
    const seen = result.advisory.length + result.fileFindings.length;
    if (seen) lines.push(`Also seen, never blocking: ${seen} note${seen === 1 ? '' : 's'}${notes ? '' : ' (rigour review --notes)'}`);
    const before = result.preexisting + result.excludedOutsideChangedLines;
    if (before) lines.push(`Not shown: ${before} issue${before === 1 ? '' : 's'} the code already had before this change (review.show_preexisting: true lists them).`);
    if (result.baseUnknown) lines.push('Compared with no base: HEAD already holds this diff, so findings on its lines were not checked against the code before it. Pass --base to compare.');
    if (result.hints.length) lines.push(`To confirm by hand: ${result.hints.length} hint${result.hints.length === 1 ? '' : 's'}${notes ? '' : ' (rigour review --notes)'}`);
    if (result.dismissed) lines.push(`Dismissed earlier as not a bug: ${result.dismissed}.`);
    if (result.muted) lines.push(`Muted: ${result.muted} from checks this repository usually dismisses (rigour precision).`);
    for (const line of lines) console.log(chalk.dim(line));
    if (result.controlFilesChanged.length) console.log(chalk.yellow(`This change edits Rigour's own settings: ${result.controlFilesChanged.join(', ')}`));
    for (const f of result.contextFindings) console.log(chalk.yellow(`Nearby, not in your change: ${f.files?.[0] || '?'}:${f.line ?? '?'} ${f.title}`));
    if (notes) {
        for (const f of [...result.advisory, ...result.fileFindings]) console.log(chalk.dim(`  ${f.files?.[0] || '?'}:${f.line ?? '?'}  ${f.title}`));
        for (const hint of result.hints) console.log(chalk.dim(`  ${hint}`));
    }
    if (lines.length || result.controlFilesChanged.length || result.contextFindings.length) console.log('');
}

/** Why the review is not a pass although it may have found nothing, and the one step that finishes it. */
function notFinished(result: ReviewResult, cwd: string): { why: string; fix: string } | undefined {
    if (result.deepError) return { why: `the model review did not run (${result.deepError})`, fix: 'Check the model settings (rigour doctor), then rigour review again.' };
    if (result.status !== 'ERROR' || result.gateErrors.length === 0) return undefined;
    if (result.typedError && (!fs.existsSync(path.join(cwd, 'node_modules')) || /not found|cannot find/i.test(result.typedError))) {
        return { why: 'the type checks need your dependencies installed', fix: `Run ${installCommand(cwd)}, then rigour review again.` };
    }
    return { why: `${result.gateErrors.join(', ')} could not run${result.typedError ? ` (${result.typedError})` : ''}`, fix: 'Fix that, then rigour review again.' };
}

/** The project's own install command, by its lockfile. */
function installCommand(cwd: string): string {
    const has = (file: string) => fs.existsSync(path.join(cwd, file));
    if (has('pnpm-lock.yaml')) return 'pnpm install';
    if (has('yarn.lock')) return 'yarn install';
    if (has('bun.lockb') || has('bun.lock')) return 'bun install';
    return 'npm install';
}

/** Rigour already runs here: a personal switch, a committed rigour.yml, or project hooks. */
function setUp(cwd: string): boolean {
    if (enabledHere(cwd) || fs.existsSync(path.join(cwd, 'rigour.yml'))) return true;
    try {
        return /hooks check/.test(fs.readFileSync(path.join(cwd, '.claude', 'settings.json'), 'utf8'));
    } catch {
        return false;
    }
}

function seconds(ms: number): string {
    return ms < 1000 ? 'under a second' : `${Math.round(ms / 1000)} s`;
}
