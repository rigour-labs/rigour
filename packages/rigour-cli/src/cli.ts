#!/usr/bin/env node
import { Command } from 'commander';
import { initCommand } from './commands/init.js';
import { checkCommand } from './commands/check.js';
import { scanCommand } from './commands/scan.js';
import { explainCommand } from './commands/explain.js';
import { runLoop } from './commands/run.js';
import { guideCommand } from './commands/guide.js';
import { setupCommand } from './commands/setup.js';
import { indexCommand } from './commands/index.js';
import { studioCommand } from './commands/studio.js';
import { exportAuditCommand } from './commands/export-audit.js';
import { demoCommand } from './commands/demo.js';
import { hooksInitCommand } from './commands/hooks.js';
import { settingsShowCommand, settingsSetKeyCommand, settingsRemoveKeyCommand, settingsSetCommand, settingsGetCommand, settingsResetCommand, settingsPathCommand } from './commands/settings.js';
import { checkForUpdates } from './utils/version.js';
import { getCliVersion } from './utils/cli-version.js';
import chalk from 'chalk';

const CLI_VERSION = getCliVersion();

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
    .option('-p, --preset <name>', 'Project preset (ui, api, infra, data, healthcare, fintech, government)')
    .option('--paradigm <name>', 'Coding paradigm (oop, functional, minimal)')
    .option('--ide <name>', 'Target IDE (cursor, vscode, all). Auto-detects if not specified.')
    .option('--dry-run', 'Show detected configuration without writing files')
    .option('--explain', 'Show detection markers for roles and paradigms')
    .option('-f, --force', 'Force re-initialization, overwriting existing rigour.yml')
    .addHelpText('after', `
Examples:
  $ rigour init                            # Auto-discover role & paradigm
  $ rigour init --preset api --explain     # Force API role and show why
  $ rigour init --preset healthcare        # HIPAA-compliant quality gates
  $ rigour init --preset fintech           # SOC2/PCI-DSS quality gates
  $ rigour init --preset government        # FedRAMP/NIST quality gates
  $ rigour init --ide all                  # Create files for all IDEs
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
    .option('--deep', 'Enable deep LLM-powered analysis (local, 350MB one-time download)')
    .option('--pro', 'Use larger model for deep analysis (900MB, higher quality)')
    .option('-k, --api-key <key>', 'Use cloud API key instead of local model (BYOK)')
    .option('--provider <name>', 'Cloud provider: claude, openai, gemini, groq, mistral, together, deepseek, ollama, or any OpenAI-compatible')
    .option('--api-base-url <url>', 'Custom API base URL (for self-hosted or proxy endpoints)')
    .option('--model-name <name>', 'Override cloud model name')
    .option('--agents <count>', 'Number of parallel agents for deep scan (cloud-only, default: 1)', '1')
    .addHelpText('after', `
Examples:
  $ rigour check                                          # AST only. Instant. Free.
  $ rigour check --deep                                   # AST + local LLM (350MB one-time)
  $ rigour check --deep --pro                             # AST + larger local LLM (900MB)
  $ rigour check --deep -k sk-ant-xxx                     # AST + Claude API (BYOK)
  $ rigour check --deep -k gsk_xxx --provider groq        # Use Groq
  $ rigour check --deep -k xxx --provider ollama          # Use local Ollama
  $ rigour check --deep -k xxx --provider custom --api-base-url http://my-server/v1  # Any endpoint
  $ rigour check ./src --deep                             # Deep on specific directory
  $ rigour check --ci                                     # CI environment
    `)
    .action(async (files: string[], options: any) => {
        await checkCommand(process.cwd(), files, options);
    });

program
    .command('scan')
    .description('Run zero-config scan with auto-detected stack and existing gates')
    .argument('[files...]', 'Specific files or directories to scan')
    .option('--ci', 'CI mode (minimal output, non-zero exit on fail)')
    .option('--json', 'Output report in JSON format')
    .option('-c, --config <path>', 'Path to custom rigour.yml configuration (optional)')
    .addHelpText('after', `
Examples:
  $ rigour scan                       # Zero-config scan in current repo
  $ rigour scan ./src                 # Scan only src
  $ rigour scan --json                # Machine-readable output
  $ rigour scan --ci                  # CI-friendly output
    `)
    .action(async (files: string[], options: any) => {
        await scanCommand(process.cwd(), files, options);
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
    .command('export-audit')
    .description('Generate a compliance audit package from the last check')
    .option('-f, --format <type>', 'Output format: json or md', 'json')
    .option('-o, --output <path>', 'Custom output file path')
    .option('--run', 'Run a fresh rigour check before exporting')
    .addHelpText('after', `
Examples:
  $ rigour export-audit                      # Export JSON audit package
  $ rigour export-audit --format md          # Export Markdown report
  $ rigour export-audit --run                # Run check first, then export
  $ rigour export-audit -o audit.json        # Custom output path
    `)
    .action(async (options: any) => {
        await exportAuditCommand(process.cwd(), options);
    });

program
    .command('demo')
    .description('Run a live demo — see Rigour catch AI drift, security issues, and structural violations')
    .option('--cinematic', 'Screen-recording mode: typewriter effects, simulated AI agent, before/after scores')
    .option('--hooks', 'Focus on real-time hooks catching issues as AI writes code')
    .option('--speed <speed>', 'Pacing: fast, normal, slow (default: normal)', 'normal')
    .addHelpText('after', `
Examples:
  $ rigour demo                          # Run the flagship demo
  $ rigour demo --cinematic              # Screen-recording optimized (great for GIFs)
  $ rigour demo --cinematic --speed slow # Slower pacing for presentations
  $ rigour demo --hooks                  # Focus on hooks catching issues
  $ npx @rigour-labs/cli demo            # Try without installing
    `)
    .action(async (options: any) => {
        await demoCommand({
            cinematic: !!options.cinematic,
            hooks: !!options.hooks,
            speed: options.speed || 'normal',
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

const hooksCmd = program
    .command('hooks')
    .description('Manage AI coding tool hook integrations');

hooksCmd
    .command('init')
    .description('Generate hook configs for AI coding tools (Claude, Cursor, Cline, Windsurf)')
    .option('-t, --tool <name>', 'Target tool(s): claude, cursor, cline, windsurf, all. Auto-detects if not specified.')
    .option('--dry-run', 'Show what files would be created without writing them')
    .option('-f, --force', 'Overwrite existing hook files')
    .option('--block', 'Configure hooks to block on failure (exit code 2)')
    .addHelpText('after', `
Examples:
  $ rigour hooks init                    # Auto-detect tools, generate hooks
  $ rigour hooks init --tool claude      # Generate Claude Code hooks only
  $ rigour hooks init --tool all         # Generate hooks for all tools
  $ rigour hooks init --dry-run          # Preview without writing files
  $ rigour hooks init --tool cursor -f   # Force overwrite Cursor hooks
    `)
    .action(async (options: any) => {
        await hooksInitCommand(process.cwd(), options);
    });

// Settings management (like Claude Code's settings.json)
const settingsCmd = program
    .command('settings')
    .description('Manage global settings (~/.rigour/settings.json) — API keys, providers, defaults');

settingsCmd
    .command('show', { isDefault: true })
    .description('Show current settings')
    .action(async () => { await settingsShowCommand(); });

settingsCmd
    .command('set-key')
    .description('Add or update an API key for a provider')
    .argument('<provider>', 'Provider name: anthropic, openai, groq, deepseek, mistral, together, gemini, ollama')
    .argument('<key>', 'API key')
    .action(async (provider: string, key: string) => { await settingsSetKeyCommand(provider, key); });

settingsCmd
    .command('remove-key')
    .description('Remove an API key for a provider')
    .argument('<provider>', 'Provider name')
    .action(async (provider: string) => { await settingsRemoveKeyCommand(provider); });

settingsCmd
    .command('set')
    .description('Set a configuration value (dot-notation)')
    .argument('<key>', 'Setting key (e.g., deep.defaultProvider, cli.verboseOutput)')
    .argument('<value>', 'Setting value')
    .action(async (key: string, value: string) => { await settingsSetCommand(key, value); });

settingsCmd
    .command('get')
    .description('Get a configuration value')
    .argument('<key>', 'Setting key')
    .action(async (key: string) => { await settingsGetCommand(key); });

settingsCmd
    .command('reset')
    .description('Reset all settings to defaults')
    .action(async () => { await settingsResetCommand(); });

settingsCmd
    .command('path')
    .description('Show settings file path')
    .action(async () => { await settingsPathCommand(); });

// Check for updates before parsing (non-blocking)
(async () => {
    try {
        const updateInfo = await checkForUpdates(CLI_VERSION);
        // Suppress update message in JSON/CI mode to keep stdout clean
        const isSilent = process.argv.includes('--json') || process.argv.includes('--ci');
        if (updateInfo?.hasUpdate && !isSilent) {
            console.log(chalk.yellow(`\n⚡ Update available: ${updateInfo.currentVersion} → ${updateInfo.latestVersion}`));
            console.log(chalk.dim(`   Run: npx @rigour-labs/cli@latest init --force\n`));
        }
    } catch {
        // Ignore version check errors
    }
    program.parse();
})();
