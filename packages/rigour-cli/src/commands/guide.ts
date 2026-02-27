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
    console.log(chalk.yellow('  • Strategic Guardians') + chalk.dim(': Dependency and Architectural boundary enforcement.\n'));

    console.log(chalk.bold('Workflow Integration:'));
    console.log(chalk.green('  • Cursor') + chalk.dim(': Add the MCP server or use the ') + chalk.cyan('.cursor/rules/rigour.mdc') + chalk.dim(' handshake.'));
    console.log(chalk.green('  • CI/CD') + chalk.dim(': Use ') + chalk.cyan('rigour check --ci') + chalk.dim(' to fail PRs that violate quality gates.\n'));

    console.log(chalk.dim('For more detailed docs, visit: ') + chalk.underline('https://github.com/erashu212/rigour/docs\n'));
}
