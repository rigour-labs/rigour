/**
 * `rigour dismiss <key>`: a person judged a finding not a bug. It is never
 * reported again in this repository (.rigour/dismissed.json for a check's
 * finding, .rigour/dismissed-review-items.json for a reviewer's; commit them to
 * share the judgement with the team and the PR bot). Agents are not offered
 * this: dismissing is a human decision.
 */
import chalk from 'chalk';
import { DISMISSED_FILE, dismissFinding, dismissReviewerFinding, REVIEW_DISMISSALS } from '@rigour-labs/core';

/** A check's finding has a 16-character key; a reviewer's finding a 10-character id (`rigour review --reviewer` shows both). */
export async function dismissCommand(cwd: string, key: string, options: { reason?: string }): Promise<void> {
    const reason = (options.reason ?? '').trim();
    if (reason.length < 5) return fail('Say why it is not a bug: --reason "…" (kept with the dismissal, for whoever reads it next).');
    if (/^[0-9a-f]{10}$/.test(key)) {
        const { item, error } = await dismissReviewerFinding(cwd, key, reason);
        if (error) return fail(error);
        console.log(chalk.green(`✔ Dismissed the reviewer's finding ${key}: ${item!.issue.slice(0, 100)}`));
        console.log(chalk.dim(`  It, or the same finding re-worded on ${item!.file ?? 'that file'}, never blocks again, and the next judges are told. Commit ${REVIEW_DISMISSALS} to share it.`));
        return;
    }
    if (!dismissFinding(cwd, key, reason)) return fail(`Not a finding key: ${key} (16 hex characters for a check's finding, 10 for a reviewer's, shown with each).`);
    console.log(chalk.green(`✔ Dismissed ${key}. Commit ${DISMISSED_FILE} so it stays quiet for everyone.`));
}

function fail(message: string): void {
    console.error(chalk.red(message));
    process.exitCode = 1;
}
