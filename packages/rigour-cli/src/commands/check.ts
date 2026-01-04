import fs from 'fs-extra';
import path from 'path';
import chalk from 'chalk';
import yaml from 'yaml';
import { GateRunner, ConfigSchema, Failure } from '@rigour-labs/core';

export async function checkCommand(cwd: string) {
    const configPath = path.join(cwd, 'rigour.yml');

    if (!(await fs.pathExists(configPath))) {
        console.error(chalk.red('Error: rigour.yml not found. Run `rigour init` first.'));
        process.exit(1);
    }

    const configContent = await fs.readFile(configPath, 'utf-8');
    const rawConfig = yaml.parse(configContent);
    const config = ConfigSchema.parse(rawConfig);

    console.log(chalk.blue('Running Rigour checks...\n'));

    const runner = new GateRunner(config);
    const report = await runner.run(cwd);

    // Write machine report
    const reportPath = path.join(cwd, config.output.report_path);
    await fs.writeJson(reportPath, report, { spaces: 2 });

    // Print human summary
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

    if (report.status !== 'PASS') {
        process.exit(1);
    }
}
