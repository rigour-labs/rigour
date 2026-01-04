#!/usr/bin/env node
import { Command } from 'commander';
import { initCommand } from './commands/init.js';
import { checkCommand } from './commands/check.js';
import { explainCommand } from './commands/explain.js';
import { runLoop } from './commands/run.js';

const program = new Command();

program
    .name('rigour')
    .description('A quality gate loop controller for AI-assisted coding')
    .version('1.0.0');

program
    .command('init')
    .description('Initialize Rigour in the current directory')
    .option('-p, --preset <name>', 'Project preset (ui, api, infra, data)')
    .option('--paradigm <name>', 'Coding paradigm (oop, functional, minimal)')
    .option('--dry-run', 'Show detected configuration without writing files')
    .option('--explain', 'Show detection markers for roles and paradigms')
    .action(async (options: any) => {
        await initCommand(process.cwd(), options);
    });

program
    .command('check')
    .description('Run quality gate checks')
    .option('--ci', 'CI mode (minimal output, non-zero exit on fail)')
    .option('--json', 'Output report in JSON format')
    .action(async (options: any) => {
        await checkCommand(process.cwd(), options);
    });

program
    .command('explain')
    .description('Explain the last quality gate report with actionable bullets')
    .action(async () => {
        await explainCommand(process.cwd());
    });

program
    .command('run')
    .description('Execute an agent command in a loop until quality gates pass')
    .argument('[command...]', 'The agent command to run (e.g., cursor-agent ...)')
    .option('-i, --iterations <number>', 'Maximum number of loop iterations (deprecated, use --max-cycles)', '3')
    .option('-c, --max-cycles <number>', 'Maximum number of loop iterations', '3')
    .option('--fail-fast', 'Abort loop immediately on first gate failure')
    .action(async (args: string[], options: any) => {
        const maxCycles = parseInt(options.maxCycles || options.iterations);
        await runLoop(process.cwd(), args, {
            iterations: maxCycles,
            failFast: !!options.failFast
        });
    });

program.parse();
