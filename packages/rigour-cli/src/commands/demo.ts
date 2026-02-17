/**
 * rigour demo
 *
 * Creates a temp project with intentional AI-generated code issues,
 * runs Rigour against it, and shows the full experience:
 *   1. Scaffolds a broken codebase
 *   2. Runs quality gates → FAIL with violations
 *   3. Shows the fix packet
 *   4. Exports an audit report
 *   5. Cleans up
 *
 * The "flagship demo" — one command to understand Rigour.
 *
 * @since v2.17.0
 */

import fs from 'fs-extra';
import path from 'path';
import chalk from 'chalk';
import yaml from 'yaml';
import os from 'os';
import { GateRunner, ConfigSchema } from '@rigour-labs/core';
import { recordScore, getScoreTrend } from '@rigour-labs/core';

export async function demoCommand() {
    console.log(chalk.bold.cyan(`
   ____  _
  / __ \\(_)____ ___  __  __ _____
 / /_/ // // __ \`/ / / / / // ___/
/ _, _// // /_/ // /_/ / / // /
/_/ |_|/_/ \\__, / \\__,_/_/ /_/
          /____/
    `));

    console.log(chalk.bold('Rigour Demo — See AI code governance in action.\n'));

    // 1. Create temp project
    const demoDir = path.join(os.tmpdir(), `rigour-demo-${Date.now()}`);
    console.log(chalk.dim(`Creating demo project at ${demoDir}...\n`));
    await fs.ensureDir(demoDir);

    await scaffoldDemoProject(demoDir);
    console.log(chalk.green('✓ Demo project scaffolded with intentional issues.\n'));

    // Show the issues planted
    console.log(chalk.bold.yellow('📋 Planted issues:'));
    console.log(chalk.dim('  1. src/auth.ts        — Hardcoded API key (security)'));
    console.log(chalk.dim('  2. src/api-handler.ts  — Unhandled promise (AI drift)'));
    console.log(chalk.dim('  3. src/data-loader.ts — Hallucinated import (AI drift)'));
    console.log(chalk.dim('  4. src/utils.ts       — TODO marker left by AI'));
    console.log(chalk.dim('  5. src/god-file.ts    — 350+ lines (structural)'));
    console.log('');

    // 2. Run quality gates
    console.log(chalk.bold.blue('🔍 Running Rigour quality gates...\n'));
    await sleep(500);

    try {
        const configContent = await fs.readFile(path.join(demoDir, 'rigour.yml'), 'utf-8');
        const rawConfig = yaml.parse(configContent);
        const config = ConfigSchema.parse(rawConfig);

        const runner = new GateRunner(config);
        const report = await runner.run(demoDir);

        // Record score
        recordScore(demoDir, report);

        // Write report
        const reportPath = path.join(demoDir, config.output.report_path);
        await fs.writeJson(reportPath, report, { spaces: 2 });

        // Display results
        const stats = report.stats;
        if (report.status === 'FAIL') {
            console.log(chalk.red.bold('✘ FAIL — Quality gate violations found.\n'));

            // Score display
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

            // Show violations
            for (const failure of report.failures) {
                const sevLabel = failure.severity === 'critical' ? chalk.red.bold('CRIT') :
                    failure.severity === 'high' ? chalk.red('HIGH') :
                    failure.severity === 'medium' ? chalk.yellow('MED ') : chalk.dim('LOW ');
                const prov = (failure as any).provenance ? chalk.dim(`[${(failure as any).provenance}]`) : '';
                console.log(`  ${sevLabel} ${prov} ${chalk.red(`[${failure.id}]`)} ${failure.title}`);
                if (failure.hint) {
                    console.log(chalk.cyan(`        💡 ${failure.hint}`));
                }
            }
            console.log('');
        } else {
            console.log(chalk.green.bold('✔ PASS — All quality gates satisfied.\n'));
        }

        console.log(chalk.dim(`Finished in ${stats.duration_ms}ms\n`));

        // 3. Generate fix packet
        if (report.status === 'FAIL') {
            const { FixPacketService } = await import('@rigour-labs/core');
            const fixPacketService = new FixPacketService();
            const fixPacket = fixPacketService.generate(report, config);
            const fixPacketPath = path.join(demoDir, 'rigour-fix-packet.json');
            await fs.writeJson(fixPacketPath, fixPacket, { spaces: 2 });
            console.log(chalk.green(`✓ Fix packet generated: rigour-fix-packet.json`));
        }

        // 4. Generate audit report
        const { exportAuditCommand } = await import('./export-audit.js');
        // We manually build a mini audit export
        const auditPath = path.join(demoDir, 'rigour-audit-report.md');
        await generateDemoAudit(demoDir, report, auditPath);
        console.log(chalk.green(`✓ Audit report exported: rigour-audit-report.md`));

        console.log('');
        console.log(chalk.bold.cyan('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
        console.log(chalk.bold('This is what Rigour does:'));
        console.log(chalk.dim('  • Catches AI drift (hallucinated imports, unhandled promises)'));
        console.log(chalk.dim('  • Blocks security issues (hardcoded keys, injection patterns)'));
        console.log(chalk.dim('  • Enforces structure (file size, complexity, documentation)'));
        console.log(chalk.dim('  • Generates audit-ready evidence (scores, trends, reports)'));
        console.log(chalk.bold.cyan('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'));

        console.log(chalk.bold('Get started:'));
        console.log(chalk.white('  $ npx @rigour-labs/cli init'));
        console.log(chalk.white('  $ npx @rigour-labs/cli check'));
        console.log('');
        console.log(chalk.dim(`Demo files: ${demoDir}`));
        console.log(chalk.dim('GitHub: https://github.com/rigour-labs/rigour'));
        console.log(chalk.dim('Docs:   https://docs.rigour.run\n'));

        console.log(chalk.dim.italic('If this saved you from a bad commit, star the repo ⭐'));

    } catch (error: any) {
        console.error(chalk.red(`Demo error: ${error.message}`));
    }
}

async function scaffoldDemoProject(dir: string) {
    // rigour.yml
    const config = {
        version: 1,
        preset: 'api',
        gates: {
            max_file_lines: 300,
            forbid_todos: true,
            forbid_fixme: true,
            ast: {
                complexity: 10,
                max_params: 5,
            },
            security: {
                enabled: true,
                block_on_severity: 'high',
            },
            hallucinated_imports: {
                enabled: true,
                severity: 'critical',
            },
            promise_safety: {
                enabled: true,
                severity: 'high',
            },
        },
        ignore: ['.git/**', 'node_modules/**'],
        output: {
            report_path: 'rigour-report.json',
        },
    };
    await fs.writeFile(path.join(dir, 'rigour.yml'), yaml.stringify(config));

    // package.json (for hallucinated import detection)
    await fs.writeJson(path.join(dir, 'package.json'), {
        name: 'rigour-demo',
        version: '1.0.0',
        dependencies: {
            express: '^4.18.0',
            zod: '^3.22.0',
        },
    }, { spaces: 2 });

    // src directory
    await fs.ensureDir(path.join(dir, 'src'));

    // Issue 1: Hardcoded API key (security)
    await fs.writeFile(path.join(dir, 'src', 'auth.ts'), `
import express from 'express';

const API_KEY = "sk-live-4f3c2b1a0987654321abcdef";
const DB_PASSWORD = "super_secret_p@ssw0rd!";

export function authenticate(req: express.Request) {
    const token = req.headers.authorization;
    if (token === API_KEY) {
        return { authenticated: true };
    }
    return { authenticated: false };
}

export function connectDatabase() {
    return { host: 'prod-db.internal', password: DB_PASSWORD };
}
`.trim());

    // Issue 2: Unhandled promise (AI drift — promise safety)
    await fs.writeFile(path.join(dir, 'src', 'api-handler.ts'), `
import express from 'express';

export async function fetchUserData(userId: string) {
    const response = await fetch(\`https://api.example.com/users/\${userId}\`);
    return response.json();
}

export function handleRequest(req: express.Request, res: express.Response) {
    // AI generated this without .catch() — floating promise
    fetchUserData(req.params.id);
    res.send('Processing...');
}

export function batchProcess(ids: string[]) {
    // Multiple unhandled promises
    ids.forEach(id => fetchUserData(id));
}
`.trim());

    // Issue 3: Hallucinated import (AI drift)
    await fs.writeFile(path.join(dir, 'src', 'data-loader.ts'), `
import { z } from 'zod';
import { magicParser } from 'ai-data-magic';
import { ultraCache } from 'quantum-cache-pro';

const schema = z.object({
    name: z.string(),
    email: z.string().email(),
});

export function loadData(raw: unknown) {
    const parsed = schema.parse(raw);
    return parsed;
}
`.trim());

    // Issue 4: TODO marker
    await fs.writeFile(path.join(dir, 'src', 'utils.ts'), `
// TODO: Claude suggested this but I need to review
// FIXME: This function has edge cases
export function formatDate(date: Date): string {
    return date.toISOString().split('T')[0];
}

export function sanitizeInput(input: string): string {
    // TODO: Add proper sanitization
    return input.trim();
}
`.trim());

    // Issue 5: God file (350+ lines)
    const godFileLines: string[] = [
        '// Auto-generated data processing module',
        'export class DataProcessor {',
    ];
    for (let i = 0; i < 60; i++) {
        godFileLines.push(`    process${i}(data: any) {`);
        godFileLines.push(`        const result = data.map((x: any) => x * ${i + 1});`);
        godFileLines.push(`        if (result.length > ${i * 10}) {`);
        godFileLines.push(`            return result.slice(0, ${i * 10});`);
        godFileLines.push(`        }`);
        godFileLines.push(`        return result;`);
        godFileLines.push(`    }`);
    }
    godFileLines.push('}');
    await fs.writeFile(path.join(dir, 'src', 'god-file.ts'), godFileLines.join('\n'));

    // docs directory (missing required docs)
    await fs.ensureDir(path.join(dir, 'docs'));
    await fs.writeFile(path.join(dir, 'README.md'), '# Demo Project\n\nThis is a demo project for Rigour.\n');
}

async function generateDemoAudit(dir: string, report: any, outputPath: string) {
    const stats = report.stats || {};
    const failures = report.failures || [];
    const lines: string[] = [];

    lines.push('# Rigour Audit Report — Demo');
    lines.push('');
    lines.push(`**Generated:** ${new Date().toISOString()}`);
    lines.push(`**Status:** ${report.status}`);
    lines.push(`**Score:** ${stats.score ?? 100}/100`);
    if (stats.ai_health_score !== undefined) lines.push(`**AI Health:** ${stats.ai_health_score}/100`);
    if (stats.structural_score !== undefined) lines.push(`**Structural:** ${stats.structural_score}/100`);
    lines.push('');
    lines.push('## Violations');
    lines.push('');

    for (let i = 0; i < failures.length; i++) {
        const f = failures[i];
        lines.push(`### ${i + 1}. [${(f.severity || 'medium').toUpperCase()}] ${f.title}`);
        lines.push(`- **ID:** \`${f.id}\``);
        lines.push(`- **Provenance:** ${(f as any).provenance || 'traditional'}`);
        lines.push(`- **Details:** ${f.details}`);
        if (f.files?.length) lines.push(`- **Files:** ${f.files.join(', ')}`);
        if (f.hint) lines.push(`- **Hint:** ${f.hint}`);
        lines.push('');
    }

    lines.push('---');
    lines.push('*Generated by Rigour — https://rigour.run*');

    await fs.writeFile(outputPath, lines.join('\n'));
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}
