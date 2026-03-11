/**
 * Code Review CLI Command
 *
 * Wraps the same core logic as the MCP `rigour_review` tool.
 * Parses a git diff (from stdin or --diff flag), runs quality gates
 * on changed files, and filters failures to modified lines only.
 *
 * Usage:
 *   git diff | rigour review --json
 *   rigour review --diff path/to/diff.patch --json
 *   rigour review --json --files src/a.ts,src/b.ts  (stdin diff)
 */
import fs from 'fs-extra';
import path from 'path';
import chalk from 'chalk';
import yaml from 'yaml';
import { GateRunner, ConfigSchema, resolveDeepOptions } from '@rigour-labs/core';
import type { DeepOptions } from '@rigour-labs/core';

const EXIT_PASS = 0;
const EXIT_FAIL = 1;
const EXIT_CONFIG_ERROR = 2;
const EXIT_INTERNAL_ERROR = 3;

export interface ReviewOptions {
    json?: boolean;
    ci?: boolean;
    config?: string;
    diff?: string;       // path to diff file
    files?: string;      // comma-separated explicit file list
    deep?: boolean;
    pro?: boolean;
    apiKey?: string;
    provider?: string;
    apiBaseUrl?: string;
    modelName?: string;
}

/**
 * Parse unified diff into a mapping of file → modified line numbers.
 * Same logic as MCP's parseDiff utility.
 */
function parseDiff(diff: string): Record<string, Set<number>> {
    const lines = diff.split('\n');
    const mapping: Record<string, Set<number>> = {};
    let currentFile = '';
    let currentLine = 0;

    for (const line of lines) {
        if (line.startsWith('+++ b/')) {
            currentFile = line.slice(6);
            mapping[currentFile] = new Set();
        } else if (line.startsWith('@@')) {
            const match = line.match(/\+(\d+)/);
            if (match) {
                currentLine = parseInt(match[1], 10);
            }
        } else if (line.startsWith('+') && !line.startsWith('+++')) {
            if (currentFile) {
                mapping[currentFile].add(currentLine);
            }
            currentLine++;
        } else if (!line.startsWith('-')) {
            currentLine++;
        }
    }
    return mapping;
}

async function readStdin(): Promise<string> {
    if (process.stdin.isTTY) return '';
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf-8');
}

export async function reviewCommand(cwd: string, options: ReviewOptions = {}) {
    // Load diff from --diff file, or stdin
    let diffContent = '';
    if (options.diff) {
        const diffPath = path.resolve(cwd, options.diff);
        if (!(await fs.pathExists(diffPath))) {
            if (options.json) {
                console.log(JSON.stringify({ error: 'INPUT_ERROR', message: `Diff file not found: ${diffPath}` }));
            } else {
                console.error(chalk.red(`Error: Diff file not found: ${diffPath}`));
            }
            process.exit(EXIT_CONFIG_ERROR);
        }
        diffContent = await fs.readFile(diffPath, 'utf-8');
    } else {
        diffContent = await readStdin();
    }

    if (!diffContent.trim()) {
        if (options.json) {
            console.log(JSON.stringify({ status: 'PASS', score: 100, failures: [], message: 'No diff provided' }));
        } else {
            console.log(chalk.green('No diff provided — nothing to review.'));
        }
        process.exit(EXIT_PASS);
    }

    // Load config
    const configPath = options.config ? path.resolve(cwd, options.config) : path.join(cwd, 'rigour.yml');
    if (!(await fs.pathExists(configPath))) {
        if (options.json) {
            console.log(JSON.stringify({ error: 'CONFIG_ERROR', message: `Config file not found: ${configPath}` }));
        } else {
            console.error(chalk.red(`Error: Config file not found at ${configPath}. Run \`rigour init\` first.`));
        }
        process.exit(EXIT_CONFIG_ERROR);
    }

    try {
        const configContent = await fs.readFile(configPath, 'utf-8');
        const config = ConfigSchema.parse(yaml.parse(configContent));

        // Parse diff into file→line mapping
        const diffMapping = parseDiff(diffContent);
        const explicitFiles = options.files ? options.files.split(',').map(f => f.trim()) : undefined;
        const targetFiles = explicitFiles || Object.keys(diffMapping);

        if (targetFiles.length === 0) {
            if (options.json) {
                console.log(JSON.stringify({ status: 'PASS', score: 100, failures: [] }));
            } else {
                console.log(chalk.green('No changed files detected in diff.'));
            }
            process.exit(EXIT_PASS);
        }

        const isDeep = !!options.deep || !!options.pro || !!options.apiKey;
        const isSilent = !!options.ci || !!options.json;

        if (!isSilent) {
            console.log(chalk.blue(`Reviewing ${targetFiles.length} file(s)...`));
            if (isDeep) console.log(chalk.blue.bold('Deep analysis enabled.\n'));
        }

        const runner = new GateRunner(config);

        // Build deep options if enabled
        let deepOpts: DeepOptions | undefined;
        if (isDeep) {
            const resolved = resolveDeepOptions({
                apiKey: options.apiKey,
                provider: options.provider,
                apiBaseUrl: options.apiBaseUrl,
                modelName: options.modelName,
            });
            const hasApiKey = !!resolved.apiKey;
            deepOpts = {
                enabled: true,
                pro: !!options.pro,
                apiKey: resolved.apiKey,
                provider: hasApiKey ? (resolved.provider || 'claude') : 'local',
                apiBaseUrl: resolved.apiBaseUrl,
                modelName: resolved.modelName,
            };
        }

        const report = await runner.run(cwd, targetFiles, deepOpts);

        // Filter failures to only those on changed lines (or global gate failures)
        const filteredFailures = report.failures.filter(failure => {
            if (!failure.files || failure.files.length === 0) return true;
            return failure.files.some(file => {
                const fileModifiedLines = diffMapping[file];
                if (!fileModifiedLines) return false;
                if (failure.line !== undefined) return fileModifiedLines.has(failure.line);
                return true;
            });
        });

        const status = filteredFailures.length > 0 ? 'FAIL' : 'PASS';

        // JSON output
        if (options.json) {
            const jsonOutput = JSON.stringify({
                status,
                score: report.stats.score,
                ai_health_score: report.stats.ai_health_score,
                structural_score: report.stats.structural_score,
                total_failures: report.failures.length,
                filtered_failures: filteredFailures.length,
                failures: filteredFailures.map(f => ({
                    id: f.id,
                    gate: f.title,
                    severity: f.severity || 'medium',
                    provenance: (f as any).provenance || 'traditional',
                    message: f.details,
                    file: f.files?.[0] || '',
                    line: f.line || 1,
                    suggestion: f.hint,
                })),
            }, null, 2);
            process.stdout.write(jsonOutput + '\n', () => {
                process.exit(status === 'PASS' ? EXIT_PASS : EXIT_FAIL);
            });
            return;
        }

        // CI output
        if (options.ci) {
            const scoreStr = report.stats.score !== undefined ? ` (${report.stats.score}/100)` : '';
            if (status === 'PASS') {
                console.log(`PASS${scoreStr}`);
            } else {
                console.log(`FAIL: ${filteredFailures.length} violation(s) on changed lines${scoreStr}`);
                for (const f of filteredFailures) {
                    const sev = (f.severity || 'medium').toUpperCase();
                    console.log(`  - [${sev}] ${f.files?.[0] || ''}:${f.line || '?'} ${f.title}`);
                }
            }
            process.exit(status === 'PASS' ? EXIT_PASS : EXIT_FAIL);
        }

        // Human-readable output
        if (status === 'PASS') {
            console.log(chalk.green.bold('\n✔ PASS — No quality issues on changed lines.\n'));
        } else {
            console.log(chalk.red.bold(`\n✘ FAIL — ${filteredFailures.length} issue(s) on changed lines.\n`));
            for (const f of filteredFailures) {
                const sev = (f.severity || 'medium').toUpperCase();
                console.log(`  ${chalk.red(`[${sev}]`)} ${f.files?.[0] || '?'}:${f.line || '?'}`);
                console.log(`    ${f.title}`);
                if (f.hint) console.log(chalk.cyan(`    → ${f.hint}`));
                console.log('');
            }
            if (report.failures.length > filteredFailures.length) {
                console.log(chalk.dim(`  (${report.failures.length - filteredFailures.length} additional issue(s) on unchanged lines were excluded)\n`));
            }
        }

        process.exit(status === 'PASS' ? EXIT_PASS : EXIT_FAIL);

    } catch (error: any) {
        if (error.name === 'ZodError') {
            if (options.json) {
                console.log(JSON.stringify({ error: 'CONFIG_ERROR', details: error.issues }));
            } else {
                console.error(chalk.red('Invalid rigour.yml configuration:'));
                error.issues.forEach((issue: any) => {
                    console.error(chalk.red(`  • ${issue.path.join('.')}: ${issue.message}`));
                });
            }
            process.exit(EXIT_CONFIG_ERROR);
        }

        if (options.json) {
            console.log(JSON.stringify({ error: 'INTERNAL_ERROR', message: error.message }));
        } else {
            console.error(chalk.red(`Internal error: ${error.message}`));
        }
        process.exit(EXIT_INTERNAL_ERROR);
    }
}
