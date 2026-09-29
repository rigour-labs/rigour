/**
 * `rigour learn`: turn a fix into a rule that catches the same bug again.
 *
 *   rigour learn <fix-commit>
 *   rigour learn --before old/http.ts --after src/http.ts
 *
 * Rules are validated before they are kept (fires before the fix, silent
 * after it, at most --max-hits places in the repository) and saved to
 * .rigour/rules/, where the semantic-bugs gate runs them. No model is used.
 */
import chalk from 'chalk';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
    extractFixTrees, learnFromFix, saveLearnedRule, LEARNED_RULES_DIR, type LearnReport, type LearnedRule,
} from '@rigour-labs/core';
import { EXIT_CONFIG_ERROR } from './exit-codes.js';

export interface LearnOptions {
    before?: string;
    after?: string;
    maxHits?: string;
    dryRun?: boolean;
    json?: boolean;
}

export async function learnCommand(cwd: string, commit: string | undefined, options: LearnOptions): Promise<void> {
    const problem = usageProblem(commit, options);
    if (problem) return fail(problem);
    const maxHits = options.maxHits === undefined ? undefined : Number(options.maxHits);

    let report: LearnReport;
    let source: string;
    try {
        ({ report, source } = commit ? await fromCommit(cwd, commit, maxHits) : await fromFiles(cwd, options.before!, options.after!, maxHits));
    } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
    }

    const saved = options.dryRun ? [] : report.learned.map(rule => path.relative(cwd, saveLearnedRule(cwd, rule)));
    if (options.json) {
        console.log(JSON.stringify({ source, ...report, rejected: report.rejected.map(r => ({ ...r.edit, reason: r.reason })), saved }, null, 2));
        return;
    }
    printReport(source, report, options.dryRun === true);
}

function usageProblem(commit: string | undefined, options: LearnOptions): string | null {
    if (options.maxHits !== undefined && !/^\d+$/.test(options.maxHits)) return '--max-hits must be a whole number of 0 or more';
    if (!commit && !(options.before && options.after)) return 'Give a fix commit, or both --before and --after';
    if (commit && (options.before || options.after)) return 'Give a fix commit or --before/--after, not both';
    return null;
}

async function fromCommit(cwd: string, commit: string, maxHits: number | undefined) {
    const trees = extractFixTrees(cwd, commit);
    try {
        const report = await learnFromFix({ ...trees, repoDir: trees.afterDir, maxHits });
        return { report, source: `fix ${trees.commit.slice(0, 8)} (${trees.files.length} changed file(s))` };
    } finally {
        trees.dispose();
    }
}

async function fromFiles(cwd: string, before: string, after: string, maxHits: number | undefined) {
    for (const file of [before, after]) {
        if (!fs.existsSync(path.resolve(cwd, file))) throw new Error(`${file} does not exist`);
    }
    const afterPath = path.resolve(cwd, after);
    const inside = !path.relative(cwd, afterPath).startsWith('..');
    const rel = (inside ? path.relative(cwd, afterPath) : path.basename(afterPath)).replace(/\\/g, '/');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rigour-learn-'));
    try {
        const place = (from: string, tree: string) => {
            const target = path.join(root, tree, rel);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.copyFileSync(path.resolve(cwd, from), target);
            return path.join(root, tree);
        };
        const report = await learnFromFix({ beforeDir: place(before, 'before'), afterDir: place(after, 'after'), repoDir: cwd, files: [rel], maxHits });
        return { report, source: `${before} -> ${after}` };
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

function printReport(source: string, report: LearnReport, dryRun: boolean): void {
    console.log(chalk.bold(`\nLearning from ${source}\n`));
    for (const rule of report.learned) printLearned(rule, dryRun);
    for (const group of groupRejections(report)) {
        const more = group.descriptions.length > 1 ? ` (+${group.descriptions.length - 1} similar)` : '';
        console.log(`${chalk.yellow('✖')} ${group.file} ${chalk.dim(`(${group.fn})`)}: ${group.descriptions[0]}${more}`);
        console.log(chalk.dim(`    not kept: every candidate failed; the narrowest ${group.reason}`));
    }
    for (const { file, fn } of report.unsupported) {
        console.log(chalk.dim(`· ${file} (${fn}): changed, but not in a shape rigour learn can generalise yet`));
    }
    const kept = report.learned.length;
    const summary = `${kept} rule(s) learned, ${report.rejected.length} rejected, ${report.unsupported.length} function(s) unsupported.`;
    console.log(`\n${kept > 0 ? chalk.green(summary) : summary}`);
    if (kept > 0 && !dryRun) console.log(chalk.dim(`Review the rules in ${LEARNED_RULES_DIR}/ and commit them; the semantic-bugs gate runs them.`));
}

/** Rejections with the same function and reason, reported once. */
function groupRejections(report: LearnReport): Array<{ file: string; fn: string; reason: string; descriptions: string[] }> {
    const groups = new Map<string, { file: string; fn: string; reason: string; descriptions: string[] }>();
    for (const { edit, reason } of report.rejected) {
        const key = `${edit.file}\0${edit.fn}\0${reason}`;
        const group = groups.get(key) ?? { file: edit.file, fn: edit.fn, reason, descriptions: [] };
        group.descriptions.push(edit.description);
        groups.set(key, group);
    }
    return [...groups.values()];
}

function printLearned(rule: LearnedRule, dryRun: boolean): void {
    const { pattern, validation } = rule;
    const reach = pattern.scope ? `regression guard for ${pattern.scope.fn} in ${pattern.scope.file}` : `every call matched by ${pattern.callee.level} \`${pattern.callee.key}\``;
    console.log(`${chalk.green('✔')} ${rule.id}`);
    console.log(`    ${rule.message}`);
    console.log(chalk.dim(`    applies to ${reach}`));
    console.log(chalk.dim(`    validated: fires ${validation.firesBefore}x before the fix, ${validation.firesAfter}x after; ${validation.repoHits.length} other hit(s) (max ${validation.maxHits})`));
    for (const hit of validation.repoHits) console.log(chalk.yellow(`      review: ${hit}`));
    console.log(chalk.dim(dryRun ? '    (dry run: not saved)' : `    saved ${path.join(LEARNED_RULES_DIR, `${rule.id}.json`)}`));
}

function fail(message: string): void {
    console.error(chalk.red(`rigour learn: ${message}`));
    process.exitCode = EXIT_CONFIG_ERROR;
}
