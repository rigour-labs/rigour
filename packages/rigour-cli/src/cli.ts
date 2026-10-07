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
import { hooksInitCommand, hooksCheckCommand } from './commands/hooks.js';
import { hooksStopCommand } from './commands/hooks-stop.js';
import { backtestCommand, backtestInitCommand } from './commands/backtest.js';
import { hooksPushCommand } from './commands/hooks-push.js';
import { hooksReviewBackgroundCommand } from './commands/hooks-review-background.js';
import { gitPushGateCommand, selfTestCommand, selfTestGitPushHook } from './commands/hooks-git.js';
import { profileAddCommand, profileListCommand, profileWhichCommand } from './commands/profile.js';
import { uninstallCommand } from './commands/uninstall.js';
import { settingsShowCommand, settingsSetKeyCommand, settingsRemoveKeyCommand, settingsSetCommand, settingsGetCommand, settingsResetCommand, settingsPathCommand } from './commands/settings.js';
import { doctorCommand } from './commands/doctor.js';
import { brainCommand } from './commands/brain.js';
import { deepStatsCommand } from './commands/deep-stats.js';
import { deepCommand } from './commands/deep.js';
import { reviewCommand } from './commands/review.js';
import { reviewStatsCommand } from './commands/review-stats.js';
import { reviewAckCommand, reviewExportCommand, reviewTaskCommand } from './commands/review-task.js';
import { reviewPostCommand } from './commands/review-post.js';
import { learnReviewsCommand } from './commands/learn-reviews.js';
import { dismissCommand } from './commands/dismiss.js';
import { precisionCommand } from './commands/precision.js';
import { telemetryCommand } from './commands/telemetry.js';
import { durationBucket, flushDailyUsage, trackUsage } from '@rigour-labs/core';
import { exportTrainingSitesCommand } from './commands/export-training-sites.js';
import { scanRulesCommand } from './commands/scan-rules.js';
import { exportReviewContextCommand } from './commands/export-review-context.js';
import { checkPatternCommand } from './commands/check-pattern.js';
import { learnCommand } from './commands/learn.js';
import { securityAuditCommand } from './commands/security-audit.js';
import { createFirewallCommand } from './commands/firewall.js';
import { teamCommand } from './commands/team.js';
import { createSkillsCommand } from './commands/skills.js';
import { checkForUpdates } from './utils/version.js';
import { getCliVersion } from './utils/cli-version.js';
import { configureHelp } from './cli-help.js';
import chalk from 'chalk';

const CLI_VERSION = getCliVersion();
process.env.RIGOUR_CLI_VERSION ??= CLI_VERSION;

const program = new Command();

program.addCommand(indexCommand);
program.addCommand(studioCommand);
program.addCommand(brainCommand);
program.addCommand(deepStatsCommand);
program.addCommand(deepCommand);
program.addCommand(teamCommand);
program.addCommand(createSkillsCommand());
program.addCommand(createFirewallCommand());

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
    .option('--ide <names>', 'Agents to set up: claude, cursor, cline, windsurf or all, comma-separated. Default: the ones this repository shows signs of')
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
  $ rigour init --ide claude,cursor        # Hooks and MCP for these agents only
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
    .option('--deep', 'Enable deep LLM-powered analysis (local lite model, 500MB one-time download)')
    .option('--pro', 'Use full deep model for analysis (Qwen2.5-Coder-1.5B, 900MB)')
    .option('--max', 'Use the strongest local model (Qwen2.5-Coder-7B, 4.7GB; 16GB RAM)')
    .option('--model-path <gguf>', 'Run a local GGUF instead of the published model (to evaluate a fine-tune)')
    .option('-k, --api-key <key>', 'Use cloud API key instead of local model (BYOK)')
    .option('--provider <name>', 'Cloud provider: claude, openai, gemini, groq, mistral, together, deepseek, ollama, or any OpenAI-compatible')
    .option('--api-base-url <url>', 'Custom API base URL (for self-hosted or proxy endpoints)')
    .option('--model-name <name>', 'Override cloud model name')
    .option('--agents <count>', 'Number of parallel agents for deep scan (cloud-only, default: 1)', '1')
    .option('--no-cache', 'Force full scan even if no files changed')
    .addHelpText('after', `
Examples:
  $ rigour check                                          # AST only. Instant. Free.
  $ rigour check --deep                                   # AST + local LLM (lite, 500MB one-time)
  $ rigour check --deep --pro                             # AST + full deep model (900MB)
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
    .option('--deep', 'Enable deep LLM-powered analysis (local lite model, 500MB one-time download)')
    .option('--pro', 'Use full deep model for analysis (Qwen2.5-Coder-1.5B, 900MB)')
    .option('--max', 'Use the strongest local model (Qwen2.5-Coder-7B, 4.7GB; 16GB RAM)')
    .option('--model-path <gguf>', 'Run a local GGUF instead of the published model (to evaluate a fine-tune)')
    .option('-k, --api-key <key>', 'Use cloud API key instead of local model (BYOK)')
    .option('--provider <name>', 'Cloud provider: claude, openai, gemini, groq, mistral, together, deepseek, ollama')
    .option('--api-base-url <url>', 'Custom API base URL')
    .option('--model-name <name>', 'Override cloud model name')
    .option('--agents <count>', 'Number of parallel agents for deep scan (cloud-only)', '1')
    .addHelpText('after', `
Examples:
  $ rigour scan                                     # Zero-config AST scan
  $ rigour scan --deep                              # Zero-config + local LLM deep analysis
  $ rigour scan --deep --pro                        # Zero-config + larger local model
  $ rigour scan --deep -k sk-ant-xxx                # Zero-config + Claude API
  $ rigour scan --deep --provider groq -k gsk_xxx   # Zero-config + Groq
  $ rigour scan ./src --deep                        # Deep scan specific directory
  $ rigour scan --json                              # Machine-readable output
  $ rigour scan --ci                                # CI-friendly output
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
    .option('--repo <url>', 'Clone a real GitHub repo and inject drift into it (festival mode)')
    .addHelpText('after', `
Examples:
  $ rigour demo                                              # Flagship demo (synthetic project)
  $ rigour demo --cinematic                                  # Screen-recording optimized
  $ rigour demo --cinematic --speed slow                     # Slower pacing for presentations
  $ rigour demo --cinematic --repo https://github.com/fastapi/fastapi  # Live demo on real repo
  $ rigour demo --hooks                                      # Focus on real-time hooks
  $ npx @rigour-labs/cli demo                                # Try without installing
    `)
    .action(async (options: any) => {
        await demoCommand({
            cinematic: !!options.cinematic,
            hooks: !!options.hooks,
            speed: options.speed || 'normal',
            repo: options.repo,
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
    .description('Set up Rigour here and check it works. Personal by default: agent hooks once per machine, this repository switched on inside .git, nothing in your working tree. --team commits it to the repository. rigour uninstall takes it out')
    .option('--team', 'Commit Rigour to this repository (rigour.yml, project hooks, .mcp.json) so everyone who clones gets it. Default: personal, nothing in your working tree')
    .option('--instructions', 'With --team: also write AGENTS.md, and a one-line CLAUDE.md that imports it, where the project has none')
    .option('--no-semantic', 'Skip installing semantic search (recall and pattern matching then use keywords)')
    .action(async (options: { semantic?: boolean; team?: boolean; instructions?: boolean }) => {
        await setupCommand(process.cwd(), options);
    });

program
    .command('doctor')
    .description('Check that Rigour is wired up and firing here, and that the install is healthy')
    .option('--clean-cache', 'Remove context-cache rows Rigour no longer reads, and shrink the database when the disk has room')
    .action(async (options: { cleanCache?: boolean }) => {
        await doctorCommand(options);
    });

program
    .command('review')
    .description('Review a change against quality gates, filtered to the lines it touches')
    .option('--json', 'Output report in JSON format')
    .option('--ci', 'CI mode (minimal output)')
    .option('--github-summary', 'Bounded, privacy-safe Markdown summary for GitHub Actions')
    .option('-c, --config <path>', 'Path to custom rigour.yml configuration')
    .option('--diff <path>', 'Path to a diff file (else stdin, else taken from git)')
    .option('--base <ref>', 'Review this branch against a base ref, e.g. main (a pull request)')
    .option('--files <paths>', 'Comma-separated list of changed files (auto-detected from diff if omitted)')
    .option('--deep', 'Enable deep LLM-powered analysis')
    .option('--pro', 'Use full deep model for analysis')
    .option('--max', 'Use the strongest local model (Qwen2.5-Coder-7B, 4.7GB; 16GB RAM)')
    .option('--model-path <gguf>', 'Run a local GGUF instead of the published model (to evaluate a fine-tune)')
    .option('--pr-body <path>', 'File with the PR description, read by --max and cloud review (default: the GitHub Actions pull request)')
    .option('--independent', 'Trust nothing the change wrote, for an enforcing check: review every risky function whatever agents recorded as reviewed, and with --base read dismissals, check outcomes and rigour.yml from the base')
    .option('--diff-tests', 'Run changed exported functions before and after the change and report behaviour changes (vitest/jest packages; needs --max or -k)')
    .option('-k, --api-key <key>', 'Cloud API key for deep analysis')
    .option('--provider <name>', 'Cloud provider for deep analysis')
    .option('--api-base-url <url>', 'Custom API base URL')
    .option('--model-name <name>', 'Override cloud model name')
    .option('--reviewer', 'Then run the reviewer (your coding agent CLI, read-only, no key): every point of every human review checked against the code, what a fix left behind, every read traced, then new findings')
    .option('--full', 'With --reviewer: two vendors, verdicts merged. Run it before asking a person to review')
    .option('--single', 'With --reviewer: one judge for this run, whatever your settings say (a team floor still applies)')
    .option('--panel', 'With --reviewer: a panel of judges for this run; only what a majority confirms blocks')
    .option('--no-panel', 'With --reviewer: no panel for this run (a team that requires one refuses this)')
    .option('--status', 'What the background reviewer has done for this branch: running, last verdict, open items')
    .option('--all', 'Show every finding, not the first five')
    .option('--notes', 'List the notes that never block')
    .option('--receipt', 'Show the receipt of agent reviews even before agents have reviewed anything here')
    .option('--scope [pr]', "In a fix round: the files changed since the latest human review that no point of it cited (the branch's pull request unless one is named)")
    .option('--scope-review <id>', 'With --scope: measure from this review instead of the latest')
    .addHelpText('after', `
Examples:
  $ rigour review                                      # Uncommitted changes, taken from git
  $ rigour review --base main --json                   # This branch against main (a PR), JSON
  $ rigour review --base origin/main --github-summary  # GitHub job summary for a PR
  $ git diff | rigour review --ci                      # Any diff on stdin
  $ rigour review --diff changes.patch --deep          # A diff file, with deep analysis

Tip: Use in CI to gate only lines you changed — faster than full rigour check on large repos.
    `)
    .action(async (options: any) => {
        await reviewCommand(process.cwd(), options);
    });

program
    .command('review-task')
    .description('The risky changed functions to review before the PR, and what to check in each (no model needed)')
    .option('--base <ref>', 'This branch against a base ref instead of uncommitted work')
    .option('--json', 'Output as JSON')
    .option('-c, --config <path>', 'Path to custom rigour.yml configuration')
    .action(async (options: any) => {
        await reviewTaskCommand(process.cwd(), options);
    });

program
    .command('review-ack <file> <function>')
    .description('Record that you reviewed a function from review-task (covers its current code only)')
    .requiredOption('--verdict <verdict>', 'fixed or no_issue')
    .requiredOption('--note <note>', 'What you checked')
    .action((file: string, fn: string, options: any) => {
        reviewAckCommand(process.cwd(), file, fn, options);
    });

program
    .command('review-export')
    .description('Write .rigour/reviewed.json (hashes and verdicts only) so the PR bot skips what was reviewed before the PR')
    .action(() => {
        reviewExportCommand(process.cwd());
    });

program
    .command('review-post')
    .description('Post a `rigour review --json` report on the pull request (GitHub Actions): a few inline comments and one summary')
    .requiredOption('--report <path>', 'The JSON report from rigour review --json')
    .option('--max-comments <n>', 'Inline comments at most (default 2)', '2')
    .action(async (options: any) => {
        await reviewPostCommand(options);
    });

program
    .command('telemetry [action]')
    .description('Anonymous usage telemetry: on, off, or status (default). Every field is listed in TELEMETRY.md')
    .action((action: string | undefined) => {
        telemetryCommand(action);
    });

program
    .command('dismiss <key>')
    .description('Mark a finding as not a bug, a check\'s or the reviewer\'s: it never blocks again here (commit .rigour/dismissed.json and .rigour/dismissed-review-items.json to share)')
    .requiredOption('--reason <reason>', 'Why it is not a bug')
    .action(async (key: string, options: any) => {
        await dismissCommand(process.cwd(), key, options);
    });

program
    .command('precision')
    .description('How this repository treats each check: findings fixed vs dismissed, and which advisory checks are muted')
    .option('--json', 'Output as JSON')
    .action((options: any) => {
        precisionCommand(process.cwd(), options);
    });

program
    .command('review-stats')
    .description('How well the agent review loop works here: reviews, findings resolved, stop checks (local event log)')
    .option('--json', 'Output as JSON')
    .action((options: any) => {
        reviewStatsCommand(process.cwd(), options);
    });

program
    .command('export-training-sites')
    .description('Export awaited call sites as JSON lines for model training (used by the driftbench fix miner)')
    .argument('[files...]', 'Files to export (default: tracked, non-test source files)')
    .action((files: string[]) => {
        exportTrainingSitesCommand(process.cwd(), files ?? []);
    });

program
    .command('export-review-context')
    .description('Print the prompt the max tier reviews for each changed file, as JSON lines (used by the driftbench review miner)')
    .requiredOption('--diff <path>', 'Unified diff of the change')
    .option('--pr-body <path>', 'File with the PR description')
    .action(async (options: { diff: string; prBody?: string }) => {
        await exportReviewContextCommand(process.cwd(), options);
    });

program
    .command('scan-rules')
    .description('Run semantic rules only and print findings as JSON lines (used by the driftbench rule validator)')
    .argument('[files...]', 'Files to scan (default: tracked, non-test source files)')
    .option('--rules <ids>', 'Comma-separated rule ids (default: all built-in rules)')
    .action((files: string[], options: { rules?: string }) => {
        scanRulesCommand(process.cwd(), files ?? [], options);
    });

program
    .command('check-pattern')
    .description('Check if a pattern already exists, is stale, or has security issues')
    .requiredOption('-n, --name <name>', 'Name of the function, class, or component to create')
    .option('-t, --type <type>', 'Pattern type (function, component, hook, class)')
    .option('-i, --intent <intent>', 'What the code is for (e.g., "format dates", "import lodash")')
    .option('--json', 'Output report in JSON format')
    .addHelpText('after', `
Examples:
  $ rigour check-pattern --name useDebounce --type hook             # Check before creating hook
  $ rigour check-pattern --name formatDate --type function --json   # JSON output
  $ rigour check-pattern --name lodash --intent "import lodash"     # Checks CVEs too
    `)
    .action(async (options: any) => {
        await checkPatternCommand(process.cwd(), options);
    });

program
    .command('learn-reviews')
    .description("Learn from review comments this repository's developers acted on, so agents get them before the next PR")
    .option('--since <date>', 'Only PRs merged on or after this date (ISO)')
    .option('--until <date>', 'Only PRs merged before this date (ISO)')
    .option('--limit <n>', 'Merged PRs to read at most', '100')
    .option('--list', 'List the lessons learned so far')
    .option('--promote <id>', 'Mark a candidate lesson verified')
    .option('--json', 'Output as JSON')
    .action(async (options: any) => {
        await learnReviewsCommand(process.cwd(), options);
    });

program
    .command('learn [commit]')
    .description('Learn a rule from a fix, so the same bug is caught next time (no model, no network)')
    .option('--before <file>', 'The file before the fix (with --after, instead of a commit)')
    .option('--after <file>', 'The file after the fix')
    .option('--agent-fixes', 'Learn from fixes agents made to Rigour findings (captured by rigour_review and the stop hook)')
    .option('--max-hits <n>', 'Reject a rule that fires on more than n other places in the repository', '3')
    .option('--dry-run', 'Report what would be learned without saving rules')
    .option('--json', 'Output the report as JSON')
    .addHelpText('after', `
A rule is kept only if it fires on the code before the fix, is silent on the
fixed code, and fires on at most --max-hits other places (listed for review).
Kept rules are saved to .rigour/rules/ and run by the semantic-bugs gate.

Examples:
  $ rigour learn a1b2c3d                              # Learn from a fix commit
  $ rigour learn --before old/http.ts --after src/http.ts
  $ rigour learn a1b2c3d --dry-run --json
  $ rigour learn --agent-fixes                        # Fixes agents made to Rigour findings
    `)
    .action(async (commit: string | undefined, options: any) => {
        await learnCommand(process.cwd(), commit, options);
    });

program
    .command('security-audit')
    .description('Run a CVE security audit on project dependencies')
    .option('--json', 'Output report in JSON format')
    .option('--ci', 'CI mode (minimal output)')
    .addHelpText('after', `
Examples:
  $ rigour security-audit                 # Human-readable security report
  $ rigour security-audit --json          # Machine-readable JSON
  $ rigour security-audit --ci            # CI pipeline integration
    `)
    .action(async (options: any) => {
        await securityAuditCommand(process.cwd(), options);
    });

const hooksCmd = program
    .command('hooks')
    .description('Manage AI coding tool hook integrations (file checks + DLP credential scanning)')
    .addHelpText('after', `
DLP false-positive learning:
  When a hook warns about your prompt incorrectly, teach Rigour once:
  $ rigour hooks check --dlp-allow-last

  Learned patterns are stored per-project in .rigour/dlp-feedback.json.
  Real secrets (provider API keys, AWS keys) are never learned away.

Examples:
  $ rigour hooks init --tool cursor
  $ rigour hooks check --mode dlp --stdin
  $ rigour hooks check --dlp-allow-last
    `);

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

hooksCmd
    .command('stop')
    .description('Stop hook: review the branch against main (on main, what the session changed) before the agent finishes; reads the hook payload on stdin')
    .option('--tool <name>', 'Hook format to reply in: claude or cursor', 'claude')
    .action(async (options: any) => {
        const chunks: Buffer[] = [];
        if (!process.stdin.isTTY) for await (const chunk of process.stdin) chunks.push(chunk);
        const tool = options.tool === 'cursor' ? 'cursor' : 'claude';
        const reply = await hooksStopCommand(tool, Buffer.concat(chunks).toString('utf8'), process.cwd());
        if (reply) process.stdout.write(reply + '\n');
    });

const backtestCmd = program
    .command('backtest')
    .description('Score the review against the points people made reviewing this repository (.rigour/backtest.json); exit 1 until every point is caught with no false block')
    .option('--round <id>', 'Run one round only')
    .option('--reviewer', 'Run the reviewer too, with each round\'s human review hidden')
    .option('--json', 'Output the score in JSON format')
    .option('-c, --config <path>', 'Path to custom rigour.yml configuration')
    .action(async (options: any) => {
        try {
            process.exit(await backtestCommand(process.cwd(), options));
        } catch (error: any) {
            console.error(chalk.red(error.message));
            process.exit(2);
        }
    });
backtestCmd
    .command('init')
    .description('Write ledger rounds from a pull request\'s human reviews (inline comments give file and line; body points need a pattern)')
    .requiredOption('--pr <number>', 'The pull request')
    .option('-c, --config <path>', 'Path to custom rigour.yml configuration')
    .action(async (options: any) => {
        try {
            process.exit(await backtestInitCommand(process.cwd(), options));
        } catch (error: any) {
            console.error(chalk.red(error.message));
            process.exit(2);
        }
    });

program
    .command('uninstall')
    .description('Take Rigour back out of this repository: switched off (personal), or its hook entries and MCP server out of the committed configs (team; your other settings stay), the files it created that you have not edited, and its git pre-push hook. Keeps rigour.yml and .rigour/ unless --all; --machine also removes it from this machine')
    .option('--all', 'Also remove rigour.yml, .rigour/ (dismissals, ledger) and Rigour\'s .gitignore lines')
    .option('--machine', 'Also remove Rigour from this machine: the user-level agent hooks and MCP server, and the shared semantic search runtime')
    .option('--dry-run', 'Say what would be removed, change nothing')
    .action((options: { all?: boolean; dryRun?: boolean; machine?: boolean }) => process.exit(uninstallCommand(process.cwd(), options)));

const profileCmd = program
    .command('profile')
    .description('One machine, many organizations: which home and team Rigour uses, chosen by repository');

profileCmd.command('list').description('List profiles').action(() => profileListCommand());
profileCmd.command('which').description('The profile and home that apply in this repository').action(() => profileWhichCommand(process.cwd()));
profileCmd
    .command('add <name>')
    .description('Add or replace a profile')
    .requiredOption('--match <entries>', 'Comma-separated path prefixes (~/work/acme) or origin remotes (github.com/acme/*)')
    .option('--home <dir>', "The home whose .rigour/ holds this profile's state")
    .option('--organization <id>', 'Team: organization id')
    .option('--team <id>', 'Team: team id')
    .option('--actor <id>', 'Team: actor id')
    .option('--repositories <patterns>', "Team: the team's repositories (github.com/acme/*)")
    .option('--database-url-command <command>', 'Team: a command that prints the database URL (never stored)')
    .option('--github-account <login>', 'The GitHub account whose token fetches pull request reviews')
    .action((name: string, options: any) => profileAddCommand(name, options));

hooksCmd
    .command('push')
    .description('Push gate: before a push, run the review, the repository\'s own tools and the typed checks on the branch; a failure refuses the push. From an agent hook (PreToolUse payload on stdin, exit 2) or from git\'s pre-push (--git, exit 1)')
    .option('--stdin', 'Read the hook payload from stdin (the default)')
    .option('--git', 'Run as git\'s pre-push hook: the refs on stdin, the commit git is about to send')
    .action(async (options: { git?: boolean }) => {
        const chunks: Buffer[] = [];
        if (!process.stdin.isTTY) for await (const chunk of process.stdin) chunks.push(chunk);
        const stdin = Buffer.concat(chunks).toString('utf8');
        const result = options.git ? await gitPushGateCommand(stdin, process.cwd()) : await hooksPushCommand(stdin, process.cwd());
        if (result.message) process.stderr.write(result.message + '\n');
        process.exit(result.exitCode);
    });

hooksCmd
    .command('selftest')
    .description('Prove the git pre-push hook: in a scratch clone of a scratch remote, a push the gate must refuse is refused and the fixed push lands, read from the remote\'s refs')
    .action(async () => {
        const result = await selfTestGitPushHook(selfTestCommand());
        for (const step of result.steps) console.log(`  ${step}`);
        console.log(result.ok ? chalk.green('  The push gate holds.') : chalk.red('  The push gate does not hold.'));
        process.exit(result.ok ? 0 : 1);
    });

hooksCmd
    .command('review-background', { hidden: true })
    .description('The detached model review the push gate starts once its checks pass: reviews the pushed commit in a worktree of its own and records the verdict')
    .requiredOption('--commit <sha>', 'The pushed commit')
    .requiredOption('--branch <name>', 'The branch it was pushed from')
    .requiredOption('--base <ref>', 'The main branch to review against')
    .option('-c, --config <path>', 'Path to custom rigour.yml configuration')
    .action(async (options: any) => {
        try {
            process.exit(await hooksReviewBackgroundCommand(process.cwd(), options));
        } catch (error: any) {
            console.error(error.message);
            process.exit(2);
        }
    });

hooksCmd
    .command('check')
    .description('Run fast hook checks for one or more files')
    .option('--files <paths>', 'Comma-separated file paths')
    .option('--stdin', 'Read hook payload from stdin (Cursor/Windsurf/Cline format)')
    .option('--block', 'Exit code 2 on failures (for blocking hooks)')
    .option('--timeout <ms>', 'Timeout in milliseconds (default: 5000)')
    .option('--mode <mode>', 'Check mode: "check" (default) or "dlp" (credential scanning)')
    .option('--agent <name>', 'Agent name for DLP audit trail (e.g., cursor, claude)')
    .option('--dlp-allow-last', 'Record the last DLP warning as learned false positives (hook feedback)')
    .addHelpText('after', `
Examples:
  $ rigour hooks check --files src/app.ts
  $ rigour hooks check --files src/a.ts,src/b.ts --block
  $ echo '{"file_path":"src/app.ts"}' | rigour hooks check --stdin
  $ echo 'AWS_SECRET=AKIA...' | rigour hooks check --mode dlp --stdin
  $ rigour hooks check --dlp-allow-last

DLP learning:
  After a false-positive warning, run --dlp-allow-last to store a safe fingerprint
  in .rigour/dlp-feedback.json. Future scans allow matching generic patterns.
  Provider keys and high-confidence secrets are never learned away.
    `)
    .action(async (options: any) => {
        await hooksCheckCommand(process.cwd(), {
            ...options,
            dlpAllowLast: options.dlpAllowLast,
        });
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
        // Suppress update message when stdout must be clean JSON:
        // --json, --ci flags, or hooks subcommand (Cursor/Claude parse stdout as JSON)
        const isSilent = process.argv.includes('--json') || process.argv.includes('--ci') || process.argv.includes('hooks');
        // Skip for local dev builds where package.json version hasn't been bumped
        const isDevBuild = CLI_VERSION === '1.0.0' || CLI_VERSION === '0.0.0';
        if (updateInfo?.hasUpdate && !isSilent && !isDevBuild) {
            // Use stderr so stdout stays clean for programmatic consumers
            console.error(chalk.yellow(`\n⚡ Update available: ${updateInfo.currentVersion} → ${updateInfo.latestVersion}`));
            console.error(chalk.dim(`   Upgrade: npm install -g @rigour-labs/cli@latest (or brew upgrade rigour), then rigour setup to point your hooks at it.\n`));
        }
    } catch {
        // Ignore version check errors
    }
    // Usage telemetry (opt-in, anonymous): which commands run and how they end. Agent hooks run on
    // every edit and are left out; `review` reports itself before it exits.
    let commandStart = Date.now();
    program.hook('preAction', () => { commandStart = Date.now(); });
    program.hook('postAction', async (_root, action) => {
        const command = action.name();
        if (command === 'hooks' || action.parent?.name() === 'hooks' || command === 'telemetry') return;
        await trackUsage('command_run', { command, outcome: process.exitCode ? 'fail' : 'ok', duration: durationBucket(Date.now() - commandStart) }, { version: CLI_VERSION });
        await flushDailyUsage({ version: CLI_VERSION });
    });
    await program.parseAsync(configureHelp(program, process.argv));
})();
