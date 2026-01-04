import fs from 'fs-extra';
import path from 'path';
import chalk from 'chalk';
import yaml from 'yaml';
import { GateRunner, ConfigSchema, Failure } from '@rigour-labs/core';

// Exit codes per spec
const EXIT_PASS = 0;
const EXIT_FAIL = 1;
const EXIT_CONFIG_ERROR = 2;
const EXIT_INTERNAL_ERROR = 3;

export interface CheckOptions {
    ci?: boolean;
    json?: boolean;
    interactive?: boolean;
}

export async function checkCommand(cwd: string, options: CheckOptions = {}) {
    const configPath = path.join(cwd, 'rigour.yml');

    if (!(await fs.pathExists(configPath))) {
        if (options.json) {
            console.log(JSON.stringify({ error: 'CONFIG_ERROR', message: 'rigour.yml not found' }));
        } else if (!options.ci) {
            console.error(chalk.red('Error: rigour.yml not found. Run `rigour init` first.'));
        }
        process.exit(EXIT_CONFIG_ERROR);
    }

    try {
        const configContent = await fs.readFile(configPath, 'utf-8');
        const rawConfig = yaml.parse(configContent);
        const config = ConfigSchema.parse(rawConfig);

        if (!options.ci && !options.json) {
            console.log(chalk.blue('Running Rigour checks...\n'));
        }

        const runner = new GateRunner(config);
        const report = await runner.run(cwd);

        // Write machine report
        const reportPath = path.join(cwd, config.output.report_path);
        await fs.writeJson(reportPath, report, { spaces: 2 });

        // Generate Fix Packet v2 on failure
        if (report.status === 'FAIL') {
            const { FixPacketService } = await import('@rigour-labs/core');
            const fixPacketService = new FixPacketService();
            const fixPacket = fixPacketService.generate(report, config);
            const fixPacketPath = path.join(cwd, 'rigour-fix-packet.json');
            await fs.writeJson(fixPacketPath, fixPacket, { spaces: 2 });
        }

        // JSON output mode
        if (options.json) {
            console.log(JSON.stringify(report, null, 2));
            process.exit(report.status === 'PASS' ? EXIT_PASS : EXIT_FAIL);
        }

        // CI mode: minimal output
        if (options.ci) {
            if (report.status === 'PASS') {
                console.log('PASS');
            } else {
                console.log(`FAIL: ${report.failures.length} violation(s)`);
                report.failures.forEach((f: Failure) => {
                    console.log(`  - [${f.id}] ${f.title}`);
                });
            }
            process.exit(report.status === 'PASS' ? EXIT_PASS : EXIT_FAIL);
        }

        // Normal human-readable output
        if (report.status === 'PASS') {
            console.log(chalk.green.bold('✔ PASS - All quality gates satisfied.'));
        } else {
            console.log(chalk.red.bold('✘ FAIL - Quality gate violations found.\n'));

            for (const failure of report.failures as Failure[]) {
                console.log(chalk.red(`[${failure.id}] ${failure.title}`));
                console.log(chalk.dim(`  Details: ${failure.details}`));
                if (failure.files && failure.files.length > 0) {
                    console.log(chalk.dim('  Files:'));
                    failure.files.forEach((f: string) => console.log(chalk.dim(`    - ${f}`)));
                }
                if (failure.hint) {
                    console.log(chalk.cyan(`  Hint: ${failure.hint}`));
                }
                console.log('');
            }

            console.log(chalk.yellow(`See ${config.output.report_path} for full details.`));
        }

        console.log(chalk.dim(`\nFinished in ${report.stats.duration_ms}ms`));

        process.exit(report.status === 'PASS' ? EXIT_PASS : EXIT_FAIL);

    } catch (error: any) {
        if (options.json) {
            console.log(JSON.stringify({ error: 'INTERNAL_ERROR', message: error.message }));
        } else if (!options.ci) {
            console.error(chalk.red(`Internal error: ${error.message}`));
        }
        process.exit(EXIT_INTERNAL_ERROR);
    }
}
