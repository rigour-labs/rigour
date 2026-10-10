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
import { findingKey, gateOf, type QualityReceipt, type ReviewResult } from '@rigour-labs/core';
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

/** Findings left out of the verdict, by check, most first (`: ast-analysis 12, file-size 1`), as `checked.preexisting` or `checked.outsideChange` gives them in JSON. */
function leftOutByCheck(counts: Record<string, number> | undefined): string {
    const parts = countsByCheck(new Map(Object.entries(counts ?? {})));
    return parts ? `: ${parts}` : '';
}

/** `ast-analysis 12, file-size 3`: most first, then by name. */
function countsByCheck(byCheck: Map<string, number>): string {
    return [...byCheck].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([check, n]) => `${check} ${n}`).join(', ');
}

/** Findings about a changed file as a whole (no line), by the check that gave them: they fail their check without a row of their own. */
function fileFindingsByCheck(result: ReviewResult): string {
    const byCheck = new Map<string, number>();
    for (const f of result.fileFindings) {
        const check = gateOf(f) ?? f.id;
        byCheck.set(check, (byCheck.get(check) ?? 0) + 1);
    }
    return countsByCheck(byCheck);
}

/**
 * One line each, in plain words, for what was seen and never blocks. With --notes, each list is printed under its own
 * line, so nothing listed sits under a "Not shown" line and reads as the issue it left out.
 */
function printQuietLines(result: ReviewResult, notes: boolean): void {
    const groups: Array<{ line: string; items?: string[] }> = [];
    const item = (f: { files?: string[]; line?: number; title: string }) => `${f.files?.[0] || '?'}:${f.line ?? '?'}  ${f.title}`;
    const seen = result.advisory.length + result.fileFindings.length;
    if (seen) groups.push({ line: `Also seen, never blocking: ${seen} note${seen === 1 ? '' : 's'}${notes ? '' : ' (rigour review --notes)'}`, items: result.advisory.map(item) });
    const wholeFile = fileFindingsByCheck(result);
    // The count above includes these: with notes on a line too, say they are part of it.
    if (wholeFile) groups.push({ line: `${result.advisory.length ? 'Of these, about' : 'About'} a changed file as a whole: ${wholeFile}${notes ? ' (listed below)' : ', shown with --notes'}.`, items: result.fileFindings.map(item) });
    if (result.hints.length) groups.push({ line: `To confirm by hand: ${result.hints.length} hint${result.hints.length === 1 ? '' : 's'}${notes ? '' : ' (rigour review --notes)'}`, items: result.hints });
    // Two kinds, each with its own pointer: show_preexisting lists only the first.
    const before = result.preexisting;
    if (before) groups.push({ line: `Not shown: ${before} issue${before === 1 ? '' : 's'} the code already had before this change${leftOutByCheck(result.preexistingByCheck)} (review.show_preexisting: true lists them).` });
    const outside = result.excludedOutsideChangedLines;
    if (outside) groups.push({ line: `Not shown: ${outside} issue${outside === 1 ? '' : 's'} on lines this change did not touch${leftOutByCheck(result.outsideChangeByCheck)}.` });
    if (result.baseUnknown) groups.push({ line: 'Compared with no base: HEAD already holds this diff, so findings on its lines were not checked against the code before it. Pass --base to compare.' });
    if (result.dismissed) groups.push({ line: `Dismissed earlier as not a bug: ${result.dismissed}.` });
    if (result.muted) groups.push({ line: `Muted: ${result.muted} from checks this repository usually dismisses (rigour precision).` });
    let open = false;
    for (const group of groups) {
        console.log(chalk.dim(group.line));
        const listed = notes ? group.items ?? [] : [];
        for (const text of listed) console.log(chalk.dim(`    ${text}`));
        // A blank line closes a list, so the next line is not read as part of it.
        if (listed.length) console.log('');
        open = !listed.length;
    }
    if (result.controlFilesChanged.length) console.log(chalk.yellow(`This change edits Rigour's own settings: ${result.controlFilesChanged.join(', ')}`));
    for (const f of result.contextFindings) console.log(chalk.yellow(`Nearby, not in your change: ${f.files?.[0] || '?'}:${f.line ?? '?'} ${f.title}`));
    if (open || result.controlFilesChanged.length || result.contextFindings.length) console.log('');
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
