/**
 * The quality receipt as `rigour review` prints it: one line of what is known about the changed
 * functions, then the risky ones nobody has reviewed at their current code.
 */
import chalk from 'chalk';
import { buildQualityReceipt, type Config, type QualityReceipt } from '@rigour-labs/core';

const LISTED = 8;

/** The receipt for this change; null when it cannot be built (no diff, not a git repository). */
export function receiptFor(cwd: string, diff: string | undefined, config: Config, independent: boolean): QualityReceipt | null {
    if (!diff) return null;
    try {
        return buildQualityReceipt(cwd, diff, { policy: config.gates.deep?.router, lessonMode: config.gates.deep?.review_lessons, independent });
    } catch {
        return null;
    }
}

export function receiptSummary(r: QualityReceipt): string {
    const parts = [
        `${r.functions} changed function${r.functions === 1 ? '' : 's'}`,
        `${r.reviewed} reviewed before this`,
        ...(r.changedSinceReview ? [`${r.changedSinceReview} changed after review`] : []),
        `${r.lowRisk} low risk`,
        `${r.notCovered.length} not covered`,
    ];
    return parts.join(' · ');
}

export function printReceipt(r: QualityReceipt): void {
    if (r.functions === 0) return;
    console.log(chalk.bold('\n  Quality receipt'));
    console.log(`  ${receiptSummary(r)}`);
    if (r.setAside) console.log(chalk.dim(`  ${r.setAside} review(s) recorded by agents were not counted: this is an independent review.`));
    for (const gap of r.notCovered.slice(0, LISTED)) {
        const why = gap.lesson ? `team lesson: ${gap.lesson}` : gap.changedSinceReview ? 'changed after its review' : 'risky, not reviewed';
        console.log(chalk.yellow(`    ${gap.file}:${gap.start} ${gap.function}`) + chalk.dim(`  ${why}`));
    }
    if (r.notCovered.length > LISTED) console.log(chalk.dim(`    …and ${r.notCovered.length - LISTED} more (see --json)`));
    if (r.notCovered.length) console.log(chalk.dim('  Review them with your agent (rigour_review, mode "agent") or run rigour review-task.'));
    console.log('');
}
