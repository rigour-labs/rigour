import chalk from 'chalk';

export function guideCommand() {
    console.log(chalk.bold.cyan('\n🛡️ Rigour Labs | The Engineering Guide\n'));

    console.log(chalk.bold('Getting Started:'));
    console.log(chalk.dim('  1. Run ') + chalk.cyan('rigour init') + chalk.dim(' to detect your project role and apply standards.'));
    console.log(chalk.dim('  2. Run ') + chalk.cyan('rigour check') + chalk.dim(' to see existing violations.'));
    console.log(chalk.dim('  3. Run ') + chalk.cyan('rigour run -- <your-agent-command>') + chalk.dim(' to automate the fix loop.\n'));

    console.log(chalk.bold('Key Concepts:'));
    console.log(chalk.yellow('  • Fix Packet v2') + chalk.dim(': Structured diagnostics fed directly into AI agents.'));
    console.log(chalk.yellow('  • File Guard') + chalk.dim(': Protects critical paths from agent modification (max files changed).'));
    console.log(chalk.yellow('  • Security Patterns') + chalk.dim(': Detects XSS, SQL injection, hardcoded secrets, command injection (enabled by default).'));
    console.log(chalk.yellow('  • DLP Hooks') + chalk.dim(': Scans prompts for credentials before they reach the model. Learns from false positives over time.'));
    console.log(chalk.yellow('  • Strategic Guardians') + chalk.dim(': Dependency and Architectural boundary enforcement.\n'));

    console.log(chalk.bold('Hooks & DLP Learning:'));
    console.log(chalk.dim('  1. Run ') + chalk.cyan('rigour hooks init') + chalk.dim(' to wire Cursor/Claude/Cline/Windsurf hooks.'));
    console.log(chalk.dim('  2. When DLP blocks a prompt falsely, run ') + chalk.cyan('rigour hooks check --dlp-allow-last'));
    console.log(chalk.dim('     to teach Rigour that pattern is safe (stored in ') + chalk.cyan('.rigour/dlp-feedback.json') + chalk.dim(').'));
    console.log(chalk.dim('  3. Real provider keys (OpenAI, AWS, etc.) still block — learning only relaxes generic shapes.\n'));

    console.log(chalk.bold('Workflow Integration:'));
    console.log(chalk.green('  • Cursor') + chalk.dim(': Add the MCP server or use the ') + chalk.cyan('.cursor/rules/rigour.mdc') + chalk.dim(' handshake.'));
    console.log(chalk.green('  • CI/CD') + chalk.dim(': Use ') + chalk.cyan('rigour check --ci') + chalk.dim(' to fail PRs that violate quality gates.'));
    console.log(chalk.green('  • PR Review') + chalk.dim(': Pipe diffs through ') + chalk.cyan('rigour review') + chalk.dim(' to gate only changed lines.\n'));

    console.log(chalk.dim('For more detailed docs, visit: ') + chalk.underline('https://github.com/erashu212/rigour/docs\n'));
}
