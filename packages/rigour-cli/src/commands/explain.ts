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

        // Score summary
        if (report.stats) {
            const stats = report.stats;
            const scoreParts: string[] = [];
            if (stats.score !== undefined) scoreParts.push(`Score: ${stats.score}/100`);
            if (stats.ai_health_score !== undefined) scoreParts.push(`AI Health: ${stats.ai_health_score}/100`);
            if (stats.structural_score !== undefined) scoreParts.push(`Structural: ${stats.structural_score}/100`);
            if (scoreParts.length > 0) {
                console.log(chalk.bold('\n' + scoreParts.join(' | ')));
            }

            // Severity breakdown
            if (stats.severity_breakdown) {
                const sevParts = Object.entries(stats.severity_breakdown)
                    .filter(([, count]: [string, any]) => count > 0)
                    .map(([sev, count]: [string, any]) => `${sev}: ${count}`);
                if (sevParts.length > 0) {
                    console.log(chalk.dim('Severity: ' + sevParts.join(', ')));
                }
            }

            // Provenance breakdown
            if (stats.provenance_breakdown) {
                const provParts = Object.entries(stats.provenance_breakdown)
                    .filter(([, count]: [string, any]) => count > 0)
                    .map(([prov, count]: [string, any]) => `${prov}: ${count}`);
                if (provParts.length > 0) {
                    console.log(chalk.dim('Categories: ' + provParts.join(', ')));
                }
            }
        }

        console.log(chalk.bold('\nGate Summary:'));
        for (const [gate, status] of Object.entries(report.summary || {})) {
            const icon = status === 'PASS' ? '✅' : status === 'FAIL' ? '❌' : '⏭️';
            console.log(`  ${icon} ${gate}: ${status}`);
        }

        if (report.failures && report.failures.length > 0) {
            console.log(chalk.bold.red(`\n🔧 ${report.failures.length} Violation(s) to Fix:\n`));

            // Severity color helper
            const sevColor = (s: string) => {
                switch (s) {
                    case 'critical': return chalk.red.bold;
                    case 'high': return chalk.red;
                    case 'medium': return chalk.yellow;
                    case 'low': return chalk.dim;
                    default: return chalk.dim;
                }
            };

            report.failures.forEach((failure: any, index: number) => {
                const sev = failure.severity || 'medium';
                const sevLabel = sevColor(sev)(`[${sev.toUpperCase()}]`);
                const provLabel = failure.provenance ? chalk.dim(`(${failure.provenance})`) : '';
                console.log(chalk.white(`${index + 1}. `) + sevLabel + ' ' + chalk.bold.yellow(`[${failure.id.toUpperCase()}]`) + ' ' + provLabel + chalk.white(` ${failure.title}`));
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
