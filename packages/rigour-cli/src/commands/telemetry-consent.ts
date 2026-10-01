/** The one-time question about anonymous usage telemetry, asked during `rigour init` at a terminal. */
import readline from 'readline';
import chalk from 'chalk';
import { setTelemetryEnabled, shouldAskTelemetry } from '@rigour-labs/core';

export async function askTelemetryOnce(input = process.stdin, output = process.stdout): Promise<void> {
    if (!shouldAskTelemetry(!!input.isTTY && !!output.isTTY)) return;
    const rl = readline.createInterface({ input, output });
    const answer = await new Promise<string>(resolve => rl.question(
        chalk.cyan('\nHelp improve Rigour with anonymous usage data? Commands, counts and which checks get dismissed;\n'
            + 'never code, paths, repo names or IPs (TELEMETRY.md). [y/N] '), resolve));
    rl.close();
    const yes = /^y(es)?$/i.test(answer.trim());
    setTelemetryEnabled(yes);
    console.log(chalk.dim(yes ? 'Thank you. Change it any time: rigour telemetry off' : 'Nothing will be sent. Change it any time: rigour telemetry on'));
}
