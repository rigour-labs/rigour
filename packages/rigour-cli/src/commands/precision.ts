/**
 * `rigour precision`: how this repository treats each check. Fixed and
 * dismissed findings give each check a Beta(fixed + 1, dismissed + 1)
 * posterior; advisory checks the team keeps dismissing are muted.
 */
import chalk from 'chalk';
import { checkPrecisions, MUTE_BELOW, MUTE_MIN_OUTCOMES, type CheckPrecision } from '@rigour-labs/core';

export function precisionCommand(cwd: string, options: { json?: boolean }): void {
    const checks = checkPrecisions(cwd);
    if (options.json) {
        console.log(JSON.stringify({ checks, muteBelow: MUTE_BELOW, muteMinOutcomes: MUTE_MIN_OUTCOMES }, null, 2));
        return;
    }
    if (checks.length === 0) {
        console.log(chalk.dim('No outcomes yet. Fixed findings and `rigour dismiss` decisions are counted per check as you work.'));
        return;
    }
    console.log(chalk.bold('Check precision here') + chalk.dim(' (chance a finding is worth acting on; fixed vs dismissed)\n'));
    for (const check of checks) console.log(row(check));
    console.log(chalk.dim(`\nAdvisory checks below ${MUTE_BELOW} after ${MUTE_MIN_OUTCOMES}+ outcomes are muted. Proven checks are never muted.`));
}

function row(check: CheckPrecision): string {
    const pct = `${Math.round(check.precision * 100)}%`.padStart(4);
    const counts = chalk.dim(`${check.fixed} fixed, ${check.dismissed} dismissed`);
    const state = check.muted ? chalk.yellow(' muted') : '';
    return `  ${pct}  ${check.check}  ${counts}${state}`;
}
