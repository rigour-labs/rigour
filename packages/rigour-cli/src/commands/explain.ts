import fs from 'fs-extra';
import path from 'path';
import chalk from 'chalk';

export async function explainCommand(cwd: string) {
    const configPath = path.join(cwd, 'rigour.yml');
    let reportPath = path.join(cwd, 'rigour-report.json');

    // Try to read custom path from config
    if (await fs.pathExists(configPath)) {
        try {
            const yaml = await import('yaml');
            const configContent = await fs.readFile(configPath, 'utf-8');
            const config = yaml.parse(configContent);
            if (config?.output?.report_path) {
                reportPath = path.join(cwd, config.output.report_path);
            }
        } catch (e) { }
    }

    if (!(await fs.pathExists(reportPath))) {
        console.error(chalk.red(`Error: No report found at ${reportPath}`));
        console.error(chalk.dim('Run `rigour check` first to generate a report.'));
        process.exit(2);
    }

    try {
        const reportContent = await fs.readFile(reportPath, 'utf-8');
        const report = JSON.parse(reportContent);

        console.log(chalk.bold('\n📋 Rigour Report Explanation\n'));
        console.log(chalk.bold('Status: ') + (report.status === 'PASS'
            ? chalk.green.bold('✅ PASS')
            : chalk.red.bold('🛑 FAIL')));

        console.log(chalk.bold('\nGate Summary:'));
        for (const [gate, status] of Object.entries(report.summary || {})) {
            const icon = status === 'PASS' ? '✅' : status === 'FAIL' ? '❌' : '⏭️';
            console.log(`  ${icon} ${gate}: ${status}`);
        }

        if (report.failures && report.failures.length > 0) {
            console.log(chalk.bold.red(`\n🔧 ${report.failures.length} Violation(s) to Fix:\n`));

            report.failures.forEach((failure: any, index: number) => {
                console.log(chalk.white(`${index + 1}. `) + chalk.bold.yellow(`[${failure.id.toUpperCase()}]`) + chalk.white(` ${failure.title}`));
                console.log(chalk.dim(`   └─ ${failure.details}`));
                if (failure.files && failure.files.length > 0) {
                    console.log(chalk.cyan(`   📁 Files: ${failure.files.join(', ')}`));
                }
                if (failure.hint) {
                    console.log(chalk.green(`   💡 Hint: ${failure.hint}`));
                }
                console.log('');
            });
        } else if (report.status === 'PASS') {
            console.log(chalk.green('\n✨ All quality gates passed! No violations found.\n'));
        }

        if (report.status === 'FAIL') {
            console.log(chalk.bold('\n👉 Next Steps:'));
            console.log(chalk.dim('   1. Refactor the code to address the violations above.'));
            console.log(chalk.dim('   2. Run `rigour check` again to verify your fixes.'));
            console.log(chalk.dim('   3. If using an agent, pass it the violations as constraints.\n'));
        }

        if (report.stats) {
            console.log(chalk.dim(`Duration: ${report.stats.duration_ms}ms`));
        }

    } catch (error: any) {
        console.error(chalk.red(`Error reading report: ${error.message}`));
        process.exit(3);
    }
}
