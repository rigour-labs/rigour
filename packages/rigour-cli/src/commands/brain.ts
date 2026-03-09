/**
 * Brain Command — inspect, compact, and reset the local project memory.
 * Storage lives at ~/.rigour/rigour.db (SQLite, WAL mode).
 */
import chalk from 'chalk';
import { Command } from 'commander';

export const brainCommand = new Command('brain')
    .description('Manage Rigour Brain — local project memory (SQLite)')
    .addHelpText('after', `
Examples:
  $ rigour brain                          # Show memory status
  $ rigour brain --compact                # Prune old data, reclaim disk
  $ rigour brain --compact --retain 30    # Keep only last 30 days
  $ rigour brain --reset                  # Wipe all memory and start fresh
    `)
    .option('--compact', 'Prune old findings, weak patterns, and reclaim disk space')
    .option('--retain <days>', 'Days of findings to keep during compact (default: 90)', '90')
    .option('--reset', 'Delete the entire database and start fresh')
    .action(async (options) => {
        const core = await import('@rigour-labs/core');

        if (options.reset) {
            await handleReset(core);
            return;
        }

        if (options.compact) {
            await handleCompact(core, parseInt(options.retain, 10));
            return;
        }

        await handleStatus(core);
    });

/** Show brain status: DB size, scan count, patterns, hard rules. */
async function handleStatus(core: any): Promise<void> {
    const sizeBytes = core.getDatabaseSize();

    if (sizeBytes === 0) {
        console.log(chalk.yellow('No Rigour Brain database found.'));
        console.log(chalk.dim('Run `rigour scan` or `rigour check` to start building local memory.'));
        return;
    }

    console.log(chalk.bold.cyan('\n🧠 Rigour Brain — Local Memory Status\n'));
    console.log(chalk.dim(`   Database: ~/.rigour/rigour.db`));
    console.log(chalk.dim(`   Size:     ${formatBytes(sizeBytes)}\n`));

    const cwd = process.cwd();
    const stats = await core.getProjectStats(cwd);

    if (!stats) {
        console.log(chalk.yellow('   SQLite not available (sqlite3 not installed).'));
        console.log(chalk.dim('   Run: npm install sqlite3'));
        return;
    }

    if (stats.totalScans === 0) {
        console.log(chalk.dim('   No scans recorded for this project yet.'));
        console.log(chalk.dim('   Run `rigour scan` to start learning.\n'));
        return;
    }

    console.log(`   Scans recorded:    ${chalk.green(stats.totalScans)}`);
    console.log(`   Learned patterns:  ${chalk.green(stats.learnedPatterns)}`);
    console.log(`   Hard rules (≥0.9): ${chalk.green(stats.hardRules)}`);

    if (stats.topPatterns.length > 0) {
        console.log(chalk.bold('\n   Top Patterns:'));
        for (const p of stats.topPatterns) {
            const bar = strengthBar(p.strength);
            console.log(`   ${bar} ${p.name} ${chalk.dim(`(seen ${p.timesSeen}x)`)}`);
        }
    }

    console.log('');
}

/** Compact: prune old findings, weak patterns, VACUUM. */
async function handleCompact(core: any, retainDays: number): Promise<void> {
    console.log(chalk.bold.cyan(`\n🧠 Compacting Rigour Brain (retain ${retainDays} days)...\n`));

    const result = await core.compactDatabase(retainDays);

    console.log(`   Findings pruned:   ${chalk.yellow(result.pruned)}`);
    console.log(`   Patterns removed:  ${chalk.yellow(result.patternsDecayed)}`);
    console.log(`   Size before:       ${formatBytes(result.sizeBefore)}`);
    console.log(`   Size after:        ${chalk.green(formatBytes(result.sizeAfter))}`);

    const saved = result.sizeBefore - result.sizeAfter;
    if (saved > 0) {
        console.log(`   Space saved:       ${chalk.green(formatBytes(saved))}`);
    }

    console.log('');
}

/** Reset: delete the entire database. */
async function handleReset(core: any): Promise<void> {
    const sizeBytes = core.getDatabaseSize();

    if (sizeBytes === 0) {
        console.log(chalk.yellow('No Rigour Brain database found. Nothing to reset.'));
        return;
    }

    console.log(chalk.bold.red(`\n⚠️  Resetting Rigour Brain`));
    console.log(chalk.dim(`   This will delete all scan history, patterns, and learned rules.`));
    console.log(chalk.dim(`   Database size: ${formatBytes(sizeBytes)}\n`));

    core.resetDatabase();
    console.log(chalk.green('   ✓ Brain reset complete. All memory cleared.\n'));
}

/** Format bytes as human-readable string. */
function formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

/** Visual strength bar for patterns. */
function strengthBar(strength: number): string {
    const filled = Math.round(strength * 10);
    const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);
    const color = strength >= 0.9 ? chalk.green : strength >= 0.7 ? chalk.yellow : chalk.dim;
    return color(`[${bar}]`);
}
