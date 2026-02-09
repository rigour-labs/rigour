#!/usr/bin/env node
import { Command } from 'commander';
import { initCommand } from './commands/init.js';
import { checkCommand } from './commands/check.js';
import { explainCommand } from './commands/explain.js';
import { runLoop } from './commands/run.js';
import { guideCommand } from './commands/guide.js';
import { setupCommand } from './commands/setup.js';
import { indexCommand } from './commands/index.js';
import { studioCommand } from './commands/studio.js';
import { checkForUpdates } from './utils/version.js';
import chalk from 'chalk';

const CLI_VERSION = '2.0.0';

const program = new Command();

program.addCommand(indexCommand);
program.addCommand(studioCommand);

program
    .name('rigour')
    .description('🛡️ Rigour: The Quality Gate Loop for AI-Assisted Engineering')
    .version(CLI_VERSION)
    .addHelpText('before', chalk.bold.cyan(`
   ____  _                               
  / __ \\(_)____ ___  __  __ _____        
 / /_/ // // __ \`/ / / / / // ___/        
/ _, _// // /_/ // /_/ / / // /            
/_/ |_|/_/ \\__, / \\__,_/_/ /_/             
          /____/                         
    `));

program
    .command('init')
    .description('Initialize Rigour in the current directory')
    .option('-p, --preset <name>', 'Project preset (ui, api, infra, data)')
    .option('--paradigm <name>', 'Coding paradigm (oop, functional, minimal)')
    .option('--ide <name>', 'Target IDE (cursor, vscode, all). Auto-detects if not specified.')
    .option('--dry-run', 'Show detected configuration without writing files')
    .option('--explain', 'Show detection markers for roles and paradigms')
    .option('-f, --force', 'Force re-initialization, overwriting existing rigour.yml')
    .addHelpText('after', `
Examples:
  $ rigour init                        # Auto-discover role & paradigm
  $ rigour init --preset api --explain # Force API role and show why
  $ rigour init --ide vscode           # Only create VS Code compatible files
  $ rigour init --ide all              # Create files for all IDEs
    `)
    .action(async (options: any) => {
        await initCommand(process.cwd(), options);
    });

program
    .command('check')
    .description('Run quality gate checks')
    .argument('[files...]', 'Specific files or directories to check')
    .option('--ci', 'CI mode (minimal output, non-zero exit on fail)')
    .option('--json', 'Output report in JSON format')
    .option('-i, --interactive', 'Run in interactive mode with rich output')
    .option('-c, --config <path>', 'Path to custom rigour.yml configuration')
    .addHelpText('after', `
Examples:
  $ rigour check                       # Run standard check
  $ rigour check ./src                 # Check only the src directory
  $ rigour check ./src/app.ts          # Check only app.ts
  $ rigour check --interactive         # Run with rich, interactive output
  $ rigour check --ci                  # Run in CI environment
    `)
    .action(async (files: string[], options: any) => {
        await checkCommand(process.cwd(), files, options);
    });

program
    .command('explain')
    .description('Explain the last quality gate report with actionable bullets')
    .addHelpText('after', `
Examples:
  $ rigour explain                     # Get a human-readable violation summary
    `)
    .action(async () => {
        await explainCommand(process.cwd());
    });

program
    .command('run')
    .description('Execute an agent command in a loop until quality gates pass')
    .argument('[command...]', 'The agent command to run (e.g., cursor-agent ...)')
    .option('-c, --max-cycles <number>', 'Maximum number of loop iterations', '3')
    .option('--fail-fast', 'Abort loop immediately on first gate failure')
    .addHelpText('after', `
Examples:
  $ rigour run -- claude "fix issues"   # Loop Claude until PASS
  $ rigour run -c 5 -- cursor-agent     # Run Cursor agent for up to 5 cycles
    `)
    .action(async (args: string[], options: any) => {
        await runLoop(process.cwd(), args, {
            iterations: parseInt(options.maxCycles),
            failFast: !!options.failFast
        });
    });

program
    .command('guide')
    .description('Show the interactive engineering guide')
    .action(async () => {
        await guideCommand();
    });

program
    .command('setup')
    .description('Show installation and global setup guidance')
    .action(async () => {
        await setupCommand();
    });

// Check for updates before parsing (non-blocking)
(async () => {
    try {
        const updateInfo = await checkForUpdates(CLI_VERSION);
        if (updateInfo?.hasUpdate) {
            console.log(chalk.yellow(`\n⚡ Update available: ${updateInfo.currentVersion} → ${updateInfo.latestVersion}`));
            console.log(chalk.dim(`   Run: npx @rigour-labs/cli@latest init --force\n`));
        }
    } catch {
        // Ignore version check errors
    }
    program.parse();
})();
