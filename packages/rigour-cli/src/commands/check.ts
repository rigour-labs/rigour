import fs from 'fs-extra';
import path from 'path';
import chalk from 'chalk';
import yaml from 'yaml';
import { GateRunner, ConfigSchema, Failure, recordScore, getScoreTrend, resolveDeepOptions, loadSettings } from '@rigour-labs/core';
import type { DeepOptions } from '@rigour-labs/core';
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
    // Deep analysis options
    deep?: boolean;
    pro?: boolean;
    apiKey?: string;
    provider?: string;
    apiBaseUrl?: string;
    modelName?: string;
    agents?: string; // String from CLI, parsed to number
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

        const isDeep = !!options.deep || !!options.pro || !!options.apiKey;
        const isSilent = !!options.ci || !!options.json;

        if (!isSilent) {
            if (isDeep) {
                console.log(chalk.blue.bold('Running Rigour checks + deep analysis...\n'));
            } else {
                console.log(chalk.blue('Running Rigour checks...\n'));
            }
        }

        const runner = new GateRunner(config);

        const requestId = randomUUID();
        await logStudioEvent(cwd, {
            type: "tool_call",
            requestId,
            tool: "rigour_check",
            arguments: { files, deep: isDeep }
        });

        // Build deep options if enabled
        // Merges CLI flags with ~/.rigour/settings.json (CLI flags win)
        let deepOpts: (DeepOptions & { onProgress?: (msg: string) => void }) | undefined;
        let resolvedDeepMode: { isLocal: boolean; provider: string } | undefined;
        if (isDeep) {
            const resolved = resolveDeepOptions({
                apiKey: options.apiKey,
                provider: options.provider,
                apiBaseUrl: options.apiBaseUrl,
                modelName: options.modelName,
            });

            // If settings.json provided an API key but user didn't pass --deep explicitly,
            // treat it as cloud mode
            const hasApiKey = !!resolved.apiKey;

            const agentCount = Math.max(1, parseInt(options.agents || '1', 10) || 1);

            deepOpts = {
                enabled: true,
                pro: !!options.pro,
                apiKey: resolved.apiKey,
                provider: hasApiKey ? (resolved.provider || 'claude') : 'local',
                apiBaseUrl: resolved.apiBaseUrl,
                modelName: resolved.modelName,
                agents: agentCount > 1 ? agentCount : undefined,
                onProgress: isSilent ? undefined : (msg: string) => {
                    process.stderr.write(msg + '\n');
                },
            };

            resolvedDeepMode = {
                isLocal: !hasApiKey || deepOpts.provider === 'local',
                provider: deepOpts.provider || 'cloud',
            };

            if (!isSilent) {
                if (!resolvedDeepMode.isLocal && !options.provider && !options.apiKey) {
                    console.log(chalk.yellow(`Deep execution defaulted to cloud (${resolvedDeepMode.provider}) from settings.`));
                    console.log(chalk.dim('Use `--provider local` to force local sidecar execution.\n'));
                } else if (options.provider === 'local' && hasApiKey) {
                    console.log(chalk.green('Deep execution forced to local (`--provider local`) even though an API key is configured.\n'));
                } else if (options.provider && options.provider !== 'local' && !hasApiKey) {
                    console.log(chalk.yellow(`Provider "${options.provider}" requested, but no API key was resolved. Falling back to local execution.\n`));
                }
            }
        }

        const report = await runner.run(cwd, files.length > 0 ? files : undefined, deepOpts);

        // Write machine report
        const reportPath = path.join(cwd, config.output.report_path);
        await fs.writeJson(reportPath, report, { spaces: 2 });

        // Record score for trend tracking
        recordScore(cwd, report);

        // Persist to SQLite if deep analysis was used
        if (isDeep) {
            try {
                const { openDatabase, insertScan, insertFindings } = await import('@rigour-labs/core');
                const db = openDatabase();
                if (db) {
                    const repoName = path.basename(cwd);
                    const scanId = insertScan(db, repoName, report, {
                        deepTier: report.stats.deep?.tier || (options.pro ? 'pro' : (resolvedDeepMode?.isLocal ? 'deep' : 'cloud')),
                        deepModel: report.stats.deep?.model,
                    });
                    insertFindings(db, scanId, report.failures);
                    db.close();
                }
            } catch (dbError: any) {
                // SQLite persistence is best-effort — log but don't fail
                if (process.env.RIGOUR_DEBUG) {
                    console.error(`[rigour] SQLite persistence failed: ${dbError.message}`);
                }
            }
        }

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

        // CI mode: minimal output with score
        if (options.ci) {
            if (report.status === 'PASS') {
                const scoreStr = report.stats.score !== undefined ? ` (${report.stats.score}/100)` : '';
                console.log(`PASS${scoreStr}`);
            } else {
                const scoreStr = report.stats.score !== undefined ? ` Score: ${report.stats.score}/100` : '';
                console.log(`FAIL: ${report.failures.length} violation(s)${scoreStr}`);
                report.failures.forEach((f: Failure) => {
                    const sev = (f.severity || 'medium').toUpperCase();
                    console.log(`  - [${sev}] [${f.id}] ${f.title}`);
                });
            }
            process.exit(report.status === 'PASS' ? EXIT_PASS : EXIT_FAIL);
        }

        if (options.interactive && report.status === 'FAIL') {
            await interactiveMode(report, config);
            process.exit(EXIT_FAIL);
        }

        // ─── HUMAN-READABLE OUTPUT (with deep analysis dopamine engineering) ───

        if (isDeep) {
            // Deep analysis output format (from product bible)
            renderDeepOutput(report, config, options, resolvedDeepMode);
        } else {
            // Standard AST-only output
            renderStandardOutput(report, config);
        }

        // Score trend display
        const trend = getScoreTrend(cwd);
        if (trend && trend.recentScores.length >= 3) {
            const arrow = trend.direction === 'improving' ? chalk.green('↑') :
                          trend.direction === 'degrading' ? chalk.red('↓') : chalk.dim('→');
            const trendColor = trend.direction === 'improving' ? chalk.green :
                               trend.direction === 'degrading' ? chalk.red : chalk.dim;
            const scoresStr = trend.recentScores.map(s => String(s)).join(' → ');
            console.log(trendColor(`\nScore Trend: ${scoresStr} (${trend.direction} ${arrow})`));
        }

        // Stats footer
        const footerParts = [`Finished in ${(report.stats.duration_ms / 1000).toFixed(1)}s`];
        if (report.stats.score !== undefined) {
            footerParts.push(`Score: ${report.stats.score}/100`);
        }
        console.log(chalk.dim('\n' + footerParts.join(' | ')));

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

/**
 * Render deep analysis output — enhanced with detailed findings grouped by provenance.
 *
 * Shows:
 * - Score box at top (AI Health, Code Quality, Overall)
 * - Detailed findings table grouped by provenance:
 *   - Deep analysis findings (most detailed): severity, category, file:line, description, suggestion
 *   - AI drift findings: severity, title, files
 *   - Security findings: severity, title, hint
 *   - Traditional findings: severity, title
 * - Privacy badge and model info
 * - Summary count at end
 */
function renderDeepOutput(
    report: any,
    config: any,
    options: CheckOptions,
    resolvedDeepMode?: { isLocal: boolean; provider: string }
) {
    const stats = report.stats;
    const isLocal = resolvedDeepMode?.isLocal ?? (stats.deep?.tier ? stats.deep.tier !== 'cloud' : !options.apiKey);
    const provider = resolvedDeepMode?.provider || options.provider || 'cloud';

    console.log('');

    if (report.status === 'PASS') {
        console.log(chalk.green.bold('  ✨ All quality gates passed.\n'));
    }

    // Score breakdown — the screenshottable moment
    const aiHealth = stats.ai_health_score ?? 100;
    const codeQuality = stats.code_quality_score ?? stats.structural_score ?? 100;
    const overall = stats.score ?? 100;

    const scoreColor = (score: number) =>
        score >= 80 ? chalk.green : score >= 60 ? chalk.yellow : chalk.red;

    console.log(`  ${chalk.bold('AI Health:')}     ${scoreColor(aiHealth).bold(aiHealth + '/100')}`);
    console.log(`  ${chalk.bold('Code Quality:')}  ${scoreColor(codeQuality).bold(codeQuality + '/100')}`);
    console.log(`  ${chalk.bold('Overall:')}       ${scoreColor(overall).bold(overall + '/100')}`);
    console.log('');

    // Privacy badge — this IS the marketing
    if (isLocal) {
        console.log(chalk.green('  🔒 Local sidecar/model execution. Code remains on this machine.'));
    } else {
        console.log(chalk.yellow(`  ☁️  Cloud provider execution. Code context may be sent to ${provider} API.`));
    }

    // Deep stats
    if (stats.deep) {
        const tier = stats.deep.tier === 'cloud' ? provider : stats.deep.tier;
        const model = stats.deep.model || 'unknown';
        const inferenceSec = stats.deep.total_ms ? (stats.deep.total_ms / 1000).toFixed(1) + 's' : '';
        console.log(chalk.dim(`  Model: ${model} (${tier}) ${inferenceSec}`));
    }

    console.log('');

    // Categorize findings by provenance
    const deepFailures = report.failures.filter((f: any) => f.provenance === 'deep-analysis');
    const aiDriftFailures = report.failures.filter((f: any) => f.provenance === 'ai-drift');
    const securityFailures = report.failures.filter((f: any) => f.provenance === 'security');
    const traditionalFailures = report.failures.filter((f: any) =>
        f.provenance !== 'deep-analysis' && f.provenance !== 'ai-drift' && f.provenance !== 'security'
    );

    // DEEP ANALYSIS FINDINGS — most detailed
    if (deepFailures.length > 0) {
        console.log(chalk.bold(`  ── Deep Analysis Findings (${deepFailures.length} verified) ──\n`));
        for (const failure of deepFailures) {
            const sev = severityIcon(failure.severity);
            const cat = failure.category || failure.id;
            const catLabel = formatCategory(cat);

            // Extract file and line from files array if available
            let fileLocation = '';
            if (failure.files && failure.files.length > 0) {
                fileLocation = failure.files[0];
            }

            // Description: up to 120 chars
            const description = failure.details ? failure.details.substring(0, 120) : failure.title.substring(0, 120);
            const descDisplay = description.length > 120 ? description.substring(0, 117) + '...' : description;

            // Suggestion from hint
            const suggestion = failure.hint || failure.suggestion || '';

            console.log(`  ${sev} [${catLabel}] ${fileLocation}`);
            console.log(`       ${descDisplay}`);

            if (suggestion) {
                console.log(`       → ${suggestion}`);
            }

            // Show confidence and verified status if available
            if (failure.confidence !== undefined || failure.verified !== undefined) {
                const confStr = failure.confidence !== undefined ? ` (${(failure.confidence * 100).toFixed(0)}% conf)` : '';
                const verStr = failure.verified !== undefined ? ` [${failure.verified ? 'verified' : 'unverified'}]` : '';
                console.log(chalk.dim(`       ${confStr}${verStr}`));
            }

            console.log('');
        }
    }

    // AI DRIFT FINDINGS
    if (aiDriftFailures.length > 0) {
        console.log(chalk.bold(`  ── AI Drift Findings (${aiDriftFailures.length}) ──\n`));
        for (const failure of aiDriftFailures) {
            const sev = severityIcon(failure.severity);
            console.log(`  ${sev} ${failure.title}`);

            if (failure.files && failure.files.length > 0) {
                console.log(`       Files: ${failure.files.slice(0, 3).join(', ')}${failure.files.length > 3 ? ` +${failure.files.length - 3}` : ''}`);
            }
            console.log('');
        }
    }

    // SECURITY FINDINGS
    if (securityFailures.length > 0) {
        console.log(chalk.bold(`  ── Security Findings (${securityFailures.length}) ──\n`));
        for (const failure of securityFailures) {
            const sev = severityIcon(failure.severity);
            console.log(`  ${sev} ${failure.title}`);

            if (failure.hint) {
                console.log(chalk.cyan(`       Hint: ${failure.hint}`));
            }
            console.log('');
        }
    }

    // TRADITIONAL FINDINGS
    if (traditionalFailures.length > 0) {
        console.log(chalk.bold(`  ── Traditional Quality Findings (${traditionalFailures.length}) ──\n`));
        for (const failure of traditionalFailures) {
            const sev = severityIcon(failure.severity);
            const prov = failure.provenance ? chalk.dim(`[${failure.provenance}]`) : '';
            console.log(`  ${sev} ${prov} ${failure.title}`);
            console.log('');
        }
    }

    // Summary count at the end
    if (deepFailures.length > 0 || aiDriftFailures.length > 0 || securityFailures.length > 0 || traditionalFailures.length > 0) {
        const summary = [
            deepFailures.length > 0 ? `${deepFailures.length} deep` : null,
            aiDriftFailures.length > 0 ? `${aiDriftFailures.length} ai-drift` : null,
            securityFailures.length > 0 ? `${securityFailures.length} security` : null,
            traditionalFailures.length > 0 ? `${traditionalFailures.length} traditional` : null
        ].filter(Boolean).join(' | ');

        console.log(chalk.dim(`  ${summary}`));
        console.log('');
    }

    console.log(chalk.yellow(`  See ${config.output.report_path} for full details.`));
}

/**
 * Render standard AST-only output (existing behavior).
 */
function renderStandardOutput(report: any, config: any) {
    if (report.status === 'PASS') {
        console.log(chalk.green.bold('✔ PASS - All quality gates satisfied.'));
    } else {
        console.log(chalk.red.bold('✘ FAIL - Quality gate violations found.\n'));

        // Score summary line
        const stats = report.stats;
        const scoreParts: string[] = [];
        if (stats.score !== undefined) scoreParts.push(`Score: ${stats.score}/100`);
        if (stats.ai_health_score !== undefined) scoreParts.push(`AI Health: ${stats.ai_health_score}/100`);
        if (stats.structural_score !== undefined) scoreParts.push(`Structural: ${stats.structural_score}/100`);
        if (scoreParts.length > 0) {
            console.log(chalk.bold(scoreParts.join(' | ')) + '\n');
        }

        // Severity breakdown
        if (stats.severity_breakdown) {
            const parts = Object.entries(stats.severity_breakdown)
                .filter(([, count]) => (count as number) > 0)
                .map(([sev, count]) => {
                    const color = sev === 'critical' ? chalk.red.bold : sev === 'high' ? chalk.red : sev === 'medium' ? chalk.yellow : chalk.dim;
                    return color(`${sev}: ${count}`);
                });
            if (parts.length > 0) {
                console.log('Severity: ' + parts.join(', ') + '\n');
            }
        }

        for (const failure of report.failures as Failure[]) {
            const sev = severityIcon(failure.severity);
            const prov = (failure as any).provenance ? chalk.dim(`[${(failure as any).provenance}]`) : '';
            console.log(`${sev} ${prov} ${chalk.red(`[${failure.id}]`)} ${failure.title}`);
            console.log(chalk.dim(`      Details: ${failure.details}`));
            if (failure.files && failure.files.length > 0) {
                console.log(chalk.dim('      Files:'));
                failure.files.forEach((f: string) => console.log(chalk.dim(`        - ${f}`)));
            }
            if (failure.hint) {
                console.log(chalk.cyan(`      Hint: ${failure.hint}`));
            }
            console.log('');
        }

        console.log(chalk.yellow(`See ${config.output.report_path} for full details.`));
    }
}

function severityIcon(s?: string): string {
    switch (s) {
        case 'critical': return chalk.red.bold('CRIT');
        case 'high': return chalk.red('HIGH');
        case 'medium': return chalk.yellow('MED ');
        case 'low': return chalk.dim('LOW ');
        case 'info': return chalk.dim('INFO');
        default: return chalk.yellow('MED ');
    }
}

function formatCategory(cat: string): string {
    const labels: Record<string, string> = {
        srp_violation: 'SOLID: Single Responsibility',
        ocp_violation: 'SOLID: Open/Closed',
        lsp_violation: 'SOLID: Liskov Substitution',
        isp_violation: 'SOLID: Interface Segregation',
        dip_violation: 'SOLID: Dependency Inversion',
        dry_violation: 'DRY',
        god_class: 'Pattern: God class',
        god_function: 'Pattern: God function',
        feature_envy: 'Pattern: Feature envy',
        shotgun_surgery: 'Pattern: Shotgun surgery',
        long_params: 'Params',
        data_clump: 'Data clump',
        inappropriate_intimacy: 'Coupling',
        error_inconsistency: 'Error handling',
        empty_catch: 'Empty catch',
        test_quality: 'Test quality',
        code_smell: 'Code smell',
        architecture: 'Architecture',
        language_idiom: 'Idiom',
    };
    return labels[cat] || cat;
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

        // Show deep analysis metadata if present
        if ((failure as any).confidence !== undefined) {
            console.log(`\n${chalk.bold('Confidence:')} ${((failure as any).confidence * 100).toFixed(0)}%`);
        }
        if ((failure as any).verified !== undefined) {
            console.log(`${chalk.bold('Verified:')} ${(failure as any).verified ? chalk.green('Yes') : chalk.red('No')}`);
        }

        console.log(chalk.dim('\n' + '─'.repeat(40)));
        await inquirer.prompt([{ type: 'input', name: 'continue', message: 'Press Enter to return to list...' }]);
        console.clear();
        console.log(chalk.bold.blue('══ Rigour Interactive Review ══\n'));
    }
}
