import { Command } from 'commander';
import { initCommand } from './commands/init.js';
import { checkCommand } from './commands/check.js';
import { runLoop } from './commands/run.js';

const program = new Command();

program
    .name('vibeguard')
    .description('A quality gate loop controller for AI-assisted coding')
    .version('0.1.0');

program
    .command('init')
    .description('Initialize VibeGuard in the current directory')
    .action(async () => {
        await initCommand(process.cwd());
    });

program
    .command('check')
    .description('Run quality gate checks')
    .action(async () => {
        await checkCommand(process.cwd());
    });

program
    .command('run')
    .description('Execute an agent command in a loop until quality gates pass')
    .argument('[command...]', 'The agent command to run (e.g., cursor-agent ...)')
    .option('-i, --iterations <number>', 'Maximum number of loop iterations', '3')
    .action(async (args, options) => {
        await runLoop(process.cwd(), args, { iterations: parseInt(options.iterations) });
    });

program.parse();
