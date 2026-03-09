/**
 * Deep Stats Command — show score trends and deep analysis history.
 * Uses the JSONL score history (no sqlite required).
 */
import chalk from 'chalk';
import { Command } from 'commander';
import { getScoreHistory, getScoreTrend } from '@rigour-labs/core';

export const deepStatsCommand = new Command('deep-stats')
    .description('Show score trends and deep analysis statistics')
    .option('--limit <n>', 'Number of recent scans to show', '10')
    .action(async (options) => {
        const cwd = process.cwd();
        const limit = parseInt(options.limit, 10) || 10;

        const history = getScoreHistory(cwd, limit);
        const trend = getScoreTrend(cwd);

        console.log(chalk.bold.cyan('\n📊 Rigour Deep Stats\n'));

        if (history.length === 0) {
            console.log(chalk.dim('   No scan history found.'));
            console.log(chalk.dim('   Run `rigour check` to start recording scores.\n'));
            return;
        }

        // Score trend
        if (trend && trend.recentScores.length >= 3) {
            const arrow = trend.direction === 'improving' ? chalk.green('↑') :
                          trend.direction === 'degrading' ? chalk.red('↓') : chalk.dim('→');
            const trendColor = trend.direction === 'improving' ? chalk.green :
                               trend.direction === 'degrading' ? chalk.red : chalk.dim;
            const scoresStr = trend.recentScores.map(s => String(s)).join(' → ');
            console.log(`   Trend:    ${trendColor(`${scoresStr} (${trend.direction} ${arrow})`)}`);
            console.log(`   Average:  ${chalk.bold(String(trend.recentAvg))} (recent) vs ${String(trend.previousAvg)} (previous)`);
            console.log('');
        }

        // Recent scans table
        console.log(chalk.bold('   Recent Scans:'));
        console.log(chalk.dim('   ─────────────────────────────────────────────'));

        for (const entry of history.slice(-limit)) {
            const date = new Date(entry.timestamp).toLocaleDateString('en-US', {
                month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
            });
            const scoreColor = entry.score >= 80 ? chalk.green :
                               entry.score >= 50 ? chalk.yellow : chalk.red;
            const statusIcon = entry.status === 'PASS' ? chalk.green('✔') : chalk.red('✘');
            const scoreBar = '█'.repeat(Math.round(entry.score / 10)) + '░'.repeat(10 - Math.round(entry.score / 10));

            console.log(`   ${statusIcon} ${chalk.dim(date)} ${scoreColor(scoreBar)} ${scoreColor(String(entry.score).padStart(3))}/100  ${chalk.dim(`${entry.failureCount} findings`)}`);
        }

        // Severity breakdown from last scan
        const latest = history[history.length - 1];
        if (latest.severity_breakdown && Object.keys(latest.severity_breakdown).length > 0) {
            console.log(chalk.bold('\n   Latest Severity Breakdown:'));
            const sev = latest.severity_breakdown;
            if (sev.critical) console.log(`   ${chalk.red('●')} Critical: ${chalk.red(String(sev.critical))}`);
            if (sev.high) console.log(`   ${chalk.yellow('●')} High:     ${chalk.yellow(String(sev.high))}`);
            if (sev.medium) console.log(`   ${chalk.blue('●')} Medium:   ${chalk.blue(String(sev.medium))}`);
            if (sev.low) console.log(`   ${chalk.dim('●')} Low:      ${chalk.dim(String(sev.low))}`);
        }

        // Provenance breakdown
        if (latest.provenance_breakdown && Object.keys(latest.provenance_breakdown).length > 0) {
            console.log(chalk.bold('\n   Latest Provenance:'));
            const prov = latest.provenance_breakdown;
            for (const [key, count] of Object.entries(prov)) {
                if (count > 0) {
                    const color = key === 'ai-drift' ? chalk.magenta :
                                  key === 'security' ? chalk.red :
                                  key === 'deep-analysis' ? chalk.blue : chalk.dim;
                    console.log(`   ${color('●')} ${key}: ${color(String(count))}`);
                }
            }
        }

        console.log('');
    });
