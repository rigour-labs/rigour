/** `rigour telemetry on|off|status`: the person's choice about anonymous usage telemetry. */
import chalk from 'chalk';
import { isTelemetryEnabled as isEnabled, readTelemetryState as readState, setTelemetryEnabled as setEnabled, telemetryToken as token } from '@rigour-labs/core';

export function telemetryCommand(action: string | undefined): void {
    if (action === 'on' || action === 'off') {
        setEnabled(action === 'on');
        console.log(action === 'on'
            ? chalk.green('✔ Anonymous usage telemetry on. Thank you: it shows which checks help and which get in the way. Every field: TELEMETRY.md')
            : chalk.green('✔ Anonymous usage telemetry off. Nothing will be sent.'));
        return;
    }
    const state = readState();
    const reason = process.env.DO_NOT_TRACK && process.env.DO_NOT_TRACK !== '0' ? ' (DO_NOT_TRACK is set)'
        : process.env.RIGOUR_TELEMETRY === '0' ? ' (RIGOUR_TELEMETRY=0)'
            : !token() ? ' (this build has no telemetry token)' : '';
    console.log(`Anonymous usage telemetry: ${isEnabled() ? chalk.green('on') : chalk.yellow('off')}${reason}`);
    if (state.enabled === undefined) console.log(chalk.dim('Not chosen yet. `rigour telemetry on` or `rigour telemetry off`.'));
    console.log(chalk.dim('What is sent, and what never is: TELEMETRY.md'));
}
