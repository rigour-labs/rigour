/**
 * `rigour review-stats`: is the agent review loop working in this repository?
 * Read from the local event log (.rigour/events.jsonl); nothing is sent anywhere.
 */
import chalk from 'chalk';
import { computeEffectiveness, listResolvedFixes, openFindingCount, readAgentEvents } from '@rigour-labs/core';

export function reviewStatsCommand(cwd: string, options: { json?: boolean } = {}): void {
    const stats = { ...computeEffectiveness(readAgentEvents(cwd)), openFindings: openFindingCount(cwd), fixesToLearn: listResolvedFixes(cwd).length };
    if (options.json) {
        console.log(JSON.stringify(stats, null, 2));
        return;
    }
    const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : 'n/a');
    console.log(chalk.bold('\nAgent review loop (from .rigour/events.jsonl)\n'));
    console.log(`  Reviews:                 ${stats.reviews} (${stats.failedReviews} with findings)`);
    console.log(`  Findings resolved:       ${stats.findingsResolved}/${stats.findingsReported} (${pct(stats.findingsResolved, stats.findingsReported)})`);
    console.log(`  Stop checks:             ${stats.stopChecks} (${stats.stopBlocks} blocked)`);
    console.log(`  Blocked, then fixed:     ${stats.blockedStopsFollowedThrough}/${stats.stopBlocks} (${pct(stats.blockedStopsFollowedThrough, stats.stopBlocks)})`);
    console.log(`  Reviewed before stopping: ${stats.stopsWithSelfReview}/${stats.stopChecks} (${pct(stats.stopsWithSelfReview, stats.stopChecks)})`);
    console.log(`  Agent fixes to learn:    ${stats.fixesToLearn}${stats.fixesToLearn ? ' (run `rigour learn --agent-fixes`)' : ''}; open findings tracked: ${stats.openFindings}`);
    const calls = Object.entries(stats.toolCalls).sort((a, b) => b[1] - a[1]);
    if (calls.length) {
        console.log(chalk.bold('\n  MCP tool calls'));
        for (const [tool, count] of calls) console.log(`    ${String(count).padStart(5)}  ${tool}`);
    }
    if (!stats.reviews && !stats.stopChecks) console.log(chalk.dim('\n  No review activity recorded yet. Agents record it through the Rigour MCP server and the stop hook.'));
    console.log('');
}
