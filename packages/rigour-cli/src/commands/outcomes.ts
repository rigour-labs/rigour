/**
 * `rigour outcomes`: what happened after the repository's recent pull requests merged (core outcomes/): CI on each merge
 * commit, the later commits on its files and the fixes among them, and a revert. Read when the outcome loop is on
 * (learning.outcomes.mode, RIGOUR_OUTCOMES, your settings, or --outcomes for this run); kept in .rigour/outcomes.json.
 */
import chalk from 'chalk';
import { runOutcomes, type OutcomeMetrics, type PrOutcome, type Share } from '@rigour-labs/core';
import { loadConfig } from './review-config.js';

export async function outcomesCommand(cwd: string, options: { pr?: string; last?: string; outcomes?: boolean; json?: boolean }): Promise<number> {
    const config = await loadConfig(cwd, {});
    const run = await runOutcomes(cwd, config, {
        ...(options.outcomes !== undefined ? { flag: options.outcomes } : {}),
        ...(options.pr ? { pr: Number(options.pr.replace(/^#/, '')) } : {}),
        ...(options.last ? { last: Number(options.last) } : {}),
    });
    // Off is a choice, not a failure: a CI step that runs this for every team stays green where outcomes are off.
    if (options.json) {
        console.log(JSON.stringify(run, null, 2));
        return 0;
    }
    for (const line of run.switch.refused) console.error(chalk.yellow(`Not applied: ${line}`));
    if (!run.switch.enabled) {
        console.log(chalk.dim(`Nothing read (${run.switch.source}): ${run.stopped}.`));
        return 0;
    }
    for (const o of run.outcomes) console.log(outcomeLine(o));
    console.log(chalk.dim(`${run.outcomes.length} pull request(s), ${run.read} read now, the rest settled.${run.stopped ? ` Stopped early: ${run.stopped}.` : ''}`));
    if (run.metrics) for (const line of metricLines(run.metrics)) console.log(chalk.dim(line));
    if (run.lessons?.added) console.log(`Lessons: ${run.lessons.added} new piece(s) of evidence, ${run.lessons.suggested.length} to look at in Studio (a later fix changed their lines), ${run.lessons.demoted.length} taken back.`);
    return 0;
}

function outcomeLine(o: PrOutcome): string {
    const fixes = o.followUps.filter(f => f.fix).length;
    const ci = o.ci === 'failure' ? chalk.red('CI failed') : o.ci === 'success' ? chalk.green('CI passed') : chalk.dim(`CI ${o.ci}`);
    const after = `${o.followUps.length} later commit(s) on its files${fixes ? `, ${chalk.yellow(`${fixes} fix(es)`)}` : ''}`;
    return `#${o.pr} ${o.mergeSha.slice(0, 9)} merged ${o.mergedAt.slice(0, 10)}: ${ci}, ${after}${o.reverted ? `, ${chalk.red(`reverted by ${o.reverted.sha.slice(0, 9)}`)}` : ''}${o.settled ? '' : chalk.dim(' (window open)')}`;
}

/** The numbers, as counts; a percentage only where there are enough records for one (metrics.ts). Reviewed and not reviewed are side by side, never compared. */
function metricLines(m: OutcomeMetrics): string[] {
    const share = (s: Share) => `${s.count} of ${s.of}${s.rate === null ? '' : ` (${Math.round(s.rate * 100)}%)`}`;
    return [
        `Numbers: ${m.records.merged} merged, ${m.records.settled} settled, ${m.records.unsettled} with the window still open.`,
        `  Settled: CI regressed on the merge ${share(m.settled.ciRegressed)}${m.settled.ciUnknown ? ` (${m.settled.ciUnknown} with no CI to read)` : ''}, reverted ${share(m.settled.reverted)}, fixed later ${share(m.settled.fixedLater)}.`,
        `  Reviewed by Rigour: ${m.settled.reviewed.prs} pull request(s), ${m.settled.reviewed.fixedLater.count} fixed later. Not reviewed: ${m.settled.notReviewed.prs}, ${m.settled.notReviewed.fixedLater.count} fixed later. (Teams choose what gets reviewed: not a comparison.)`,
        `  The model reviewer: ${m.model.share.model} of ${m.model.share.model + m.model.share.checks} finding(s) at first review on ${m.model.share.prs} pull request(s)${m.model.share.rate === null ? '' : ` (${Math.round(m.model.share.rate * 100)}%)`}; $${m.model.costPerPr.totalUsd.toFixed(2)} over ${m.model.costPerPr.prs} pull request(s)${m.model.costPerPr.medianUsd === null ? '' : `, median $${m.model.costPerPr.medianUsd.toFixed(2)}`}.`,
        `  Lessons: ${m.lessons.awaitingDecision} waiting on a person, ${m.lessons.promotedFromEvidence} promoted from evidence, ${m.lessons.dismissed} dismissed, ${m.lessons.takenBack} taken back.`,
    ];
}
