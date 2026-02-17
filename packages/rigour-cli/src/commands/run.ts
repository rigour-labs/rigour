import fs from 'fs-extra';
import path from 'path';
import chalk from 'chalk';
import yaml from 'yaml';
import { execa } from 'execa';
import { GateRunner, ConfigSchema } from '@rigour-labs/core';

// Exit codes per spec
const EXIT_PASS = 0;
const EXIT_FAIL = 1;
const EXIT_CONFIG_ERROR = 2;
const EXIT_INTERNAL_ERROR = 3;

export async function runLoop(cwd: string, agentArgs: string[], options: { iterations: number, failFast?: boolean }) {
    const configPath = path.join(cwd, 'rigour.yml');

    if (!(await fs.pathExists(configPath))) {
        console.error(chalk.red('Error: rigour.yml not found. Run `rigour init` first.'));
        process.exit(EXIT_CONFIG_ERROR);
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

            // 1. Prepare Command
            let currentArgs = [...agentArgs];
            if (iteration > 1 && agentArgs.length > 0) {
                // Iteration contract: In later cycles, we focus strictly on the fix packet
                console.log(chalk.yellow(`\n🔄 REFINEMENT CYCLE - Instructing agent to fix specific violations...`));
                // We keep the first part of the command (the agent) but can append or wrap
                // For simplicity, we assume the agent can read the JSON file we generate
            }

            const getTrackedChanges = async () => {
                try {
                    const { stdout } = await execa('git', ['status', '--porcelain'], { cwd });
                    return stdout.split('\n')
                        .filter(l => l.trim())
                        .filter(line => /M|A|D|R/.test(line.slice(0, 2)))
                        .map(l => l.slice(3).trim());
                } catch (e) {
                    return [];
                }
            };

            // Snapshot changed files before agent runs
            const beforeFiles = await getTrackedChanges();

            // 2. Run the agent command
            if (currentArgs.length > 0) {
                console.log(chalk.cyan(`\n🚀 DEPLOYING AGENT:`));
                console.log(chalk.dim(`   Command: ${currentArgs.join(' ')}`));
                try {
                    await execa(currentArgs[0], currentArgs.slice(1), { shell: true, stdio: 'inherit', cwd });
                } catch (error: any) {
                    console.warn(chalk.yellow(`\n⚠️  Agent command finished with non-zero exit code. Rigour will now verify state...`));
                }
            }

            // Snapshot changed files after agent runs
            const afterFiles = await getTrackedChanges();

            const changedThisCycle = afterFiles.filter(f => !beforeFiles.includes(f));
            const maxFiles = config.gates.safety?.max_files_changed_per_cycle || 10;

            if (changedThisCycle.length > maxFiles) {
                console.log(chalk.red.bold(`\n🛑 FILE GUARD ABORT: Agent changed ${changedThisCycle.length} files (max: ${maxFiles}).`));
                console.log(chalk.red(`   This looks like explosive behavior. Check your agent's instructions.`));
                process.exit(EXIT_FAIL);
            }

            // 3. Run Rigour Check
            console.log(chalk.magenta('\n🔍 AUDITING QUALITY GATES...'));
            const report = await runner.run(cwd);

            // Write report
            const reportPath = path.join(cwd, config.output.report_path);
            await fs.writeJson(reportPath, report, { spaces: 2 });

            if (report.status === 'PASS') {
                console.log(chalk.green.bold('\n✨ PASS - All quality gates satisfied.'));
                console.log(chalk.green(`   Your solution meets the required Engineering Rigour criteria.\n`));
                return;
            }

            // 4. Generate Fix Packet v2
            const { FixPacketService } = await import('@rigour-labs/core');
            const fixPacketService = new FixPacketService();
            const fixPacket = fixPacketService.generate(report, config);
            const fixPacketPath = path.join(cwd, 'rigour-fix-packet.json');
            await fs.writeJson(fixPacketPath, fixPacket, { spaces: 2 });

            console.log(chalk.red.bold(`\n🛑 FAIL - Found ${report.failures.length} engineering violations.`));
            console.log(chalk.dim(`   Fix Packet generated: rigour-fix-packet.json`));

            if (options.failFast) {
                console.log(chalk.red.bold(`\n🛑 FAIL-FAST: Aborting loop as requested.`));
                process.exit(EXIT_FAIL);
            }

            // Print summary
            const summary = report.failures.map((f, i) => {
                return chalk.white(`${i + 1}. `) + chalk.bold.red(`[${f.id.toUpperCase()}] `) + chalk.white(f.title);
            }).join('\n');
            console.log(chalk.bold.white('\n📋 VIOLATIONS SUMMARY:'));
            console.log(summary);

            if (iteration === maxIterations) {
                console.log(chalk.red.bold(`\n❌ CRITICAL: Reached maximum iterations (${maxIterations}).`));
                console.log(chalk.red(`   Quality gates remain unfulfilled. Refactor manually or check agent logs.`));
                process.exit(EXIT_FAIL);
            }

            console.log(chalk.dim('\nReturning control to agent for the next refinement cycle...'));
        }
    } catch (error: any) {
        console.error(chalk.red(`\n❌ FATAL ERROR: ${error.message}`));
        if (error.issues) {
            console.error(chalk.dim(JSON.stringify(error.issues, null, 2)));
        }
        process.exit(EXIT_INTERNAL_ERROR);
    }
}
