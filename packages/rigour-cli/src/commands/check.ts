import fs from 'fs-extra';
import path from 'path';
import chalk from 'chalk';
import yaml from 'yaml';
import { GateRunner, ConfigSchema, Failure } from '@rigour-labs/core';
import inquirer from 'inquirer';
import { randomUUID } from 'crypto';

// Exit codes per spec
const EXIT_PASS = 0;
const EXIT_FAIL = 1;
const EXIT_CONFIG_ERROR = 2;
const EXIT_INTERNAL_ERROR = 3;

export interface CheckOptions {
    ci?: boolean;
    json?: boolean;
    interactive?: boolean;
    config?: string;
}

// Helper to log events for Rigour Studio
async function logStudioEvent(cwd: string, event: any) {
    try {
        const rigourDir = path.join(cwd, ".rigour");
        await fs.ensureDir(rigourDir);
        const eventsPath = path.join(rigourDir, "events.jsonl");
        const logEntry = JSON.stringify({
            id: randomUUID(),
            timestamp: new Date().toISOString(),
            ...event
        }) + "\n";
        await fs.appendFile(eventsPath, logEntry);
    } catch {
        // Silent fail
    }
}

export async function checkCommand(cwd: string, files: string[] = [], options: CheckOptions = {}) {
    const configPath = options.config ? path.resolve(cwd, options.config) : path.join(cwd, 'rigour.yml');

    if (!(await fs.pathExists(configPath))) {
        if (options.json) {
            console.log(JSON.stringify({ error: 'CONFIG_ERROR', message: `Config file not found: ${configPath}` }));
        } else if (!options.ci) {
            console.error(chalk.red(`Error: Config file not found at ${configPath}. Run \`rigour init\` first or provide a valid path.`));
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

        const requestId = randomUUID();
        await logStudioEvent(cwd, {
            type: "tool_call",
            requestId,
            tool: "rigour_check",
            arguments: { files }
        });

        const report = await runner.run(cwd, files.length > 0 ? files : undefined);

        // Write machine report
        const reportPath = path.join(cwd, config.output.report_path);
        await fs.writeJson(reportPath, report, { spaces: 2 });

        await logStudioEvent(cwd, {
            type: "tool_response",
            requestId,
            tool: "rigour_check",
            status: report.status === 'PASS' ? 'success' : 'error',
            content: [{ type: "text", text: `Audit Result: ${report.status}` }],
            _rigour_report: report
        });

        // Generate Fix Packet v2 on failure
        if (report.status === 'FAIL') {
            const { FixPacketService } = await import('@rigour-labs/core');
            const fixPacketService = new FixPacketService();
            const fixPacket = fixPacketService.generate(report, config);
            const fixPacketPath = path.join(cwd, 'rigour-fix-packet.json');
            await fs.writeJson(fixPacketPath, fixPacket, { spaces: 2 });
        }

        // JSON output mode - use stdout.write for large outputs to avoid truncation
        if (options.json) {
            const jsonOutput = JSON.stringify(report, null, 2);
            process.stdout.write(jsonOutput + '\n', () => {
                process.exit(report.status === 'PASS' ? EXIT_PASS : EXIT_FAIL);
            });
            return; // Wait for write callback
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

        if (options.interactive && report.status === 'FAIL') {
            await interactiveMode(report, config);
            process.exit(EXIT_FAIL);
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
        if (error.name === 'ZodError') {
            if (options.json) {
                console.log(JSON.stringify({ error: 'CONFIG_ERROR', details: error.issues }));
            } else {
                console.error(chalk.red('\nInvalid rigour.yml configuration:'));
                error.issues.forEach((issue: any) => {
                    console.error(chalk.red(`  • ${issue.path.join('.')}: ${issue.message}`));
                });
            }
            process.exit(EXIT_CONFIG_ERROR);
        }

        if (options.json) {
            console.log(JSON.stringify({ error: 'INTERNAL_ERROR', message: error.message }));
        } else if (!options.ci) {
            console.error(chalk.red(`Internal error: ${error.message}`));
        }
        process.exit(EXIT_INTERNAL_ERROR);
    }
}

async function interactiveMode(report: any, config: any) {
    console.clear();
    console.log(chalk.bold.blue('══ Rigour Interactive Review ══\n'));
    console.log(chalk.yellow(`${report.failures.length} violations found.\n`));

    const choices = report.failures.map((f: Failure, i: number) => ({
        name: `[${f.id}] ${f.title}`,
        value: i
    }));

    choices.push(new (inquirer as any).Separator());
    choices.push({ name: 'Exit', value: -1 });

    let exit = false;
    while (!exit) {
        const { index } = await inquirer.prompt([
            {
                type: 'list',
                name: 'index',
                message: 'Select a violation to view details:',
                choices,
                pageSize: 15
            }
        ]);

        if (index === -1) {
            exit = true;
            continue;
        }

        const failure = report.failures[index];
        console.clear();
        console.log(chalk.bold.red(`\nViolation: ${failure.title}`));
        console.log(chalk.dim(`ID: ${failure.id}`));
        console.log(`\n${chalk.bold('Details:')}\n${failure.details}`);

        if (failure.files && failure.files.length > 0) {
            console.log(`\n${chalk.bold('Impacted Files:')}`);
            failure.files.forEach((f: string) => console.log(chalk.dim(`  - ${f}`)));
        }

        if (failure.hint) {
            console.log(`\n${chalk.bold.cyan('Hint:')} ${failure.hint}`);
        }

        console.log(chalk.dim('\n' + '─'.repeat(40)));
        await inquirer.prompt([{ type: 'input', name: 'continue', message: 'Press Enter to return to list...' }]);
        console.clear();
        console.log(chalk.bold.blue('══ Rigour Interactive Review ══\n'));
    }
}
