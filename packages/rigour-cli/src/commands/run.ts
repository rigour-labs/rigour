import fs from 'fs-extra';
import path from 'path';
import chalk from 'chalk';
import yaml from 'yaml';
import { execa } from 'execa';
import { GateRunner, ConfigSchema } from '@rigour-labs/core';

export async function runLoop(cwd: string, agentArgs: string[], options: { iterations: number }) {
    const configPath = path.join(cwd, 'rigour.yml');

    if (!(await fs.pathExists(configPath))) {
        console.error(chalk.red('Error: rigour.yml not found. Run `rigour init` first.'));
        process.exit(1);
    }

    try {
        const configContent = await fs.readFile(configPath, 'utf-8');
        const rawConfig = yaml.parse(configContent);
        const config = ConfigSchema.parse(rawConfig);
        const runner = new GateRunner(config);

        let iteration = 0;
        const maxIterations = options.iterations;

        while (iteration < maxIterations) {
            iteration++;
            console.log(chalk.bold.blue(`\n══════════════════════════════════════════════════════════════════`));
            console.log(chalk.bold.blue(`  RIGOUR LOOP: Iteration ${iteration}/${maxIterations}`));
            console.log(chalk.bold.blue(`══════════════════════════════════════════════════════════════════`));

            // 1. Run the agent command
            if (agentArgs.length > 0) {
                console.log(chalk.cyan(`\n🚀 DEPLOYING AGENT:`));
                console.log(chalk.dim(`   Command: ${agentArgs.join(' ')}`));
                try {
                    await execa(agentArgs[0], agentArgs.slice(1), { shell: true, stdio: 'inherit', cwd });
                } catch (error: any) {
                    console.warn(chalk.yellow(`\n⚠️  Agent command finished with non-zero exit code. Rigour will now verify state...`));
                }
            }

            // 2. Run Rigour Check
            console.log(chalk.magenta('\n🔍 AUDITING QUALITY GATES...'));
            const report = await runner.run(cwd);

            if (report.status === 'PASS') {
                console.log(chalk.green.bold('\n✨ PASS - All quality gates satisfied.'));
                console.log(chalk.green(`   Your solution meets the required Engineering Rigour criteria.\n`));
                return;
            }

            // 3. Generate and print Fix Packet for next iteration
            console.log(chalk.red.bold(`\n🛑 FAIL - Found ${report.failures.length} engineering violations.`));

            const fixPacket = report.failures.map((f, i) => {
                let msg = chalk.white(`${i + 1}. `) + chalk.bold.red(`[${f.id.toUpperCase()}] `) + chalk.white(f.title);
                msg += `\n   ├─ ` + chalk.dim(`Details: ${f.details}`);
                if (f.hint) msg += `\n   └─ ` + chalk.yellow(`FIX: ${f.hint}`);
                return msg;
            }).join('\n\n');

            console.log(chalk.bold.white('\n📋 ACTIONABLE FIX PACKET:'));
            console.log(fixPacket);
            console.log(chalk.dim('\nReturning control to agent for the next refinement cycle...'));

            if (iteration === maxIterations) {
                console.log(chalk.red.bold(`\n❌ CRITICAL: Reached maximum iterations (${maxIterations}).`));
                console.log(chalk.red(`   Quality gates remain unfulfilled. Refactor manually or check agent logs.`));
                process.exit(1);
            }
        }
    } catch (error: any) {
        console.error(chalk.red(`\n❌ FATAL ERROR: ${error.message}`));
        if (error.issues) {
            console.error(chalk.dim(JSON.stringify(error.issues, null, 2)));
        }
        process.exit(1);
    }
}
