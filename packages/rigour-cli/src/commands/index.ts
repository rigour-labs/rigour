/**
 * Index Command
 * 
 * Builds and updates the Rigour Pattern Index to prevent code reinvention.
 */

import { Command } from 'commander';
import path from 'path';
import chalk from 'chalk';
import ora from 'ora';
// Dynamic imports are used inside the action handler below to prevent
// native dependency issues from affecting the rest of the CLI.

export const indexCommand = new Command('index')
    .description('Build or update the pattern index for the current project')
    .option('-s, --semantic', 'Generate semantic embeddings for better matching (requires Transformers.js)', false)
    .option('-f, --force', 'Force a full rebuild of the index', false)
    .option('-o, --output <path>', 'Custom path for the index file')
    .action(async (options) => {
        const cwd = process.cwd();

        // Dynamic import to isolate native dependencies
        const {
            PatternIndexer,
            savePatternIndex,
            loadPatternIndex,
            getDefaultIndexPath
        } = await import('@rigour-labs/core/pattern-index');

        const indexPath = options.output || getDefaultIndexPath(cwd);
        const spinner = ora('Initializing pattern indexer...').start();

        try {
            const indexer = new PatternIndexer(cwd, {
                useEmbeddings: options.semantic
            });

            let index;
            const existingIndex = await loadPatternIndex(indexPath);

            if (existingIndex && !options.force) {
                spinner.text = 'Updating existing pattern index...';
                index = await indexer.updateIndex(existingIndex);
            } else {
                spinner.text = 'Building fresh pattern index (this may take a while)...';
                index = await indexer.buildIndex();
            }

            spinner.text = 'Saving index to disk...';
            await savePatternIndex(index, indexPath);

            spinner.succeed(chalk.green(`Pattern index built successfully!`));
            console.log(chalk.blue(`- Total Patterns: ${index.stats.totalPatterns}`));
            console.log(chalk.blue(`- Total Files: ${index.stats.totalFiles}`));
            console.log(chalk.blue(`- Index Path: ${indexPath}`));

            if (options.semantic) {
                console.log(chalk.magenta(`- Semantic Search: Enabled (Local Transformers.js)`));
            }

            const byType = Object.entries(index.stats.byType)
                .map(([type, count]) => `${type}: ${count}`)
                .join(', ');
            console.log(chalk.gray(`Types: ${byType}`));

        } catch (error: any) {
            spinner.fail(chalk.red(`Failed to build pattern index: ${error.message}`));
            process.exit(1);
        }
    });
