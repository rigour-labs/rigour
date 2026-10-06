/**
 * `rigour backtest`: how good the review is on this repository's own history. Each round in
 * `.rigour/backtest.json` is a commit a person reviewed; the review runs on it with that review
 * hidden, and the score says which of the person's points Rigour would have caught before them,
 * and whether it would have blocked code the person called good. Exit 1 until every point is
 * caught with no false block, so a rule change is measured, not believed.
 */
import chalk from 'chalk';
import { backtestPassed, formatBacktest, loadLedger, runBacktest, scaffoldLedger, LEDGER_PATH } from '@rigour-labs/core';
import { loadConfig, UsageError } from './review-config.js';

export interface BacktestOptions { round?: string; reviewer?: boolean; json?: boolean; config?: string }

export async function backtestCommand(cwd: string, options: BacktestOptions): Promise<number> {
    const config = await loadConfig(cwd, options);
    const ledger = loadLedger(cwd);
    const results = await runBacktest(cwd, config, ledger, {
        round: options.round,
        reviewer: options.reviewer,
        progress: message => process.stderr.write(`${message}\n`),
    });
    const passed = backtestPassed(results);
    if (options.json) console.log(JSON.stringify({ passed, rounds: results }, null, 2));
    else console.log((passed ? chalk.green : chalk.red)(formatBacktest(results)));
    return passed ? 0 : 1;
}

export async function backtestInitCommand(cwd: string, options: { pr: string; config?: string }): Promise<number> {
    const pr = Number(options.pr);
    if (!Number.isInteger(pr) || pr <= 0) throw new UsageError('--pr takes the pull request number');
    const config = await loadConfig(cwd, options);
    const { rounds, incomplete } = await scaffoldLedger(cwd, pr, config);
    console.log(`${LEDGER_PATH}: ${rounds.length} round(s) from pull request ${pr}, ${rounds.reduce((n, r) => n + r.points.length, 0)} point(s)`);
    if (incomplete) console.log(chalk.yellow(`${incomplete} point(s) need a pattern before the ledger runs (search for "needs")`));
    return 0;
}
