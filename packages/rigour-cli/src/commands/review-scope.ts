/**
 * `rigour review --scope [pr]`: in a fix round, the files the branch changed since the review it
 * answers that no point of that review cited. Exit 0 when there are none, 1 when there are, 3 when
 * it could not tell (no pull request, no review by a person, the reviewed commit not here).
 */
import chalk from 'chalk';
import { fixScope, type FixScope } from '@rigour-labs/core';
import { loadConfig, UsageError } from './review-config.js';
import { EXIT_FAIL, EXIT_INTERNAL_ERROR, EXIT_PASS } from './exit-codes.js';

export interface ScopeOptions {
    scope?: string | boolean;
    scopeReview?: string;
    json?: boolean;
    config?: string;
}

export async function printScope(cwd: string, options: ScopeOptions): Promise<number> {
    const pr = numberOption(options.scope === true ? undefined : options.scope, '--scope');
    const review = numberOption(options.scopeReview, '--scope-review');
    const config = await loadConfig(cwd, options);
    const { scope, error } = await fixScope(cwd, { pr, review, githubAccount: config.review?.github_account ?? process.env.RIGOUR_GITHUB_ACCOUNT });
    const status = error ? 'ERROR' : scope!.extra.length ? 'FAIL' : 'PASS';
    if (options.json) console.log(JSON.stringify({ status, ...(scope ?? {}), ...(error ? { error } : {}) }, null, 2));
    else if (error) console.log(chalk.yellow(`⚠ Could not check the fix round's scope: ${error}`));
    else printHuman(scope!);
    return status === 'PASS' ? EXIT_PASS : status === 'FAIL' ? EXIT_FAIL : EXIT_INTERNAL_ERROR;
}

function printHuman(scope: FixScope): void {
    const files = (n: number) => `${n} file${n === 1 ? '' : 's'}`;
    console.log(`\nFix round since ${scope.review.login}'s review of ${scope.review.commit.slice(0, 9)} (pull request ${scope.pr}): ${files(scope.changed.length)} changed, ${files(scope.cited.length)} cited.\n`);
    if (scope.extra.length === 0) {
        console.log(chalk.green.bold('✔ Every file this round changed is one the review cited.\n'));
        return;
    }
    console.log(chalk.red.bold(`✘ ${files(scope.extra.length)} no point of the review cited:\n`));
    for (const file of scope.extra) console.log(`  ${file}`);
    console.log(chalk.dim('\n  Revert each, or move it to a follow-up. Merges from main are not counted.\n'));
}

function numberOption(value: string | boolean | undefined, flag: string): number | undefined {
    if (value === undefined || value === false) return undefined;
    if (!/^\d+$/.test(String(value))) throw new UsageError(`${flag} takes a number, not "${value}"`);
    return Number(value);
}
