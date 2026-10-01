/**
 * `rigour dismiss <key>`: a person judged a finding not a bug. It is never
 * reported again in this repository (.rigour/dismissed.json; commit it to
 * share the judgement with the team and the PR bot). Agents are not offered
 * this: dismissing is a human decision.
 */
import chalk from 'chalk';
import { DISMISSED_FILE, dismissFinding } from '@rigour-labs/core';

export function dismissCommand(cwd: string, key: string, options: { reason?: string }): void {
    const reason = (options.reason ?? '').trim();
    if (reason.length < 5) {
        console.error(chalk.red('Say why it is not a bug: --reason "…" (kept with the dismissal, for whoever reads it next).'));
        process.exitCode = 1;
        return;
    }
    if (!dismissFinding(cwd, key, reason)) {
        console.error(chalk.red(`Not a finding key: ${key} (16 hex characters, shown with each finding).`));
        process.exitCode = 1;
        return;
    }
    console.log(chalk.green(`✔ Dismissed ${key}. Commit ${DISMISSED_FILE} so it stays quiet for everyone.`));
}
