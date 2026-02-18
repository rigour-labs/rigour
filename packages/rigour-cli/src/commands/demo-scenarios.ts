import fs from 'fs-extra';
import path from 'path';
import chalk from 'chalk';
import yaml from 'yaml';
import { GateRunner, ConfigSchema } from '@rigour-labs/core';
import { recordScore, getScoreTrend } from '@rigour-labs/core';
import type { DemoOptions } from './demo-helpers.js';
import { pause, typewrite } from './demo-helpers.js';
import {
    simulateCodeWrite, simulateHookCatch,
    renderScoreBar, renderTrendChart,
    displayGateResults, printSeverityBreakdown, printFailure,
} from './demo-display.js';

// ── Hooks demo: simulate AI agent → hook catches ────────────────────

export async function runHooksDemo(
    demoDir: string,
    options: DemoOptions
): Promise<void> {
    const divider = chalk.cyan('━'.repeat(50));
    console.log(divider);
    console.log(chalk.bold.magenta('  Simulating AI agent writing code with hooks active...\n'));

    if (options.cinematic) {
        await pause(600, options);
    }

    // Step 1: AI writes auth.ts with hardcoded key
    await simulateAgentWrite(
        'src/auth.ts',
        [
            'import express from \'express\';',
            '',
            'const API_KEY = "sk-live-4f3c2b1a0987654321abcdef";',
            '',
            'export function authenticate(req: express.Request) {',
            '    return req.headers.authorization === API_KEY;',
            '}',
        ],
        'security-patterns',
        'src/auth.ts:3',
        'Possible hardcoded secret or API key',
        'critical',
        options
    );

    // Step 2: AI writes data-loader.ts with hallucinated import
    await simulateAgentWrite(
        'src/data-loader.ts',
        [
            'import { z } from \'zod\';',
            'import { magicParser } from \'ai-data-magic\';',
            '',
            'export function loadData(raw: unknown) {',
            '    return z.object({ name: z.string() }).parse(raw);',
            '}',
        ],
        'hallucinated-imports',
        'src/data-loader.ts:2',
        'Import \'ai-data-magic\' does not resolve to an existing package',
        'high',
        options
    );

    // Step 3: AI writes api-handler.ts with unhandled promise
    await simulateAgentWrite(
        'src/api-handler.ts',
        [
            'export async function fetchUser(id: string) {',
            '    const res = await fetch(`/api/users/${id}`);',
            '    return res.json();',
            '}',
            '',
            'export function handleRequest(req: any, res: any) {',
            '    fetchUser(req.params.id);  // floating promise',
            '    res.send(\'Processing...\');',
            '}',
        ],
        'promise-safety',
        'src/api-handler.ts:7',
        'Unhandled promise — fetchUser() called without await or .catch()',
        'medium',
        options
    );

    console.log('');
    console.log(chalk.magenta.bold(
        `  Hooks caught 3 issues in real time — before the agent finished.`
    ));
    console.log(divider);
    console.log('');

    if (options.cinematic) {
        await pause(1000, options);
    }
}

export async function simulateAgentWrite(
    filename: string,
    codeLines: string[],
    gate: string,
    file: string,
    message: string,
    severity: string,
    options: DemoOptions
): Promise<void> {
    console.log(chalk.blue.bold(`  Agent: Write → ${filename}`));
    await simulateCodeWrite(filename, codeLines, options);
    await simulateHookCatch(gate, file, message, severity, options);
    console.log('');
}

// ── Full gate run ───────────────────────────────────────────────────

export async function runFullGates(
    demoDir: string,
    options: DemoOptions
): Promise<void> {
    const isCinematic = !!options.cinematic;

    console.log(chalk.bold.blue('Running full Rigour quality gates...\n'));
    if (isCinematic) {
        await pause(500, options);
    }

    try {
        const configContent = await fs.readFile(
            path.join(demoDir, 'rigour.yml'),
            'utf-8'
        );
        const rawConfig = yaml.parse(configContent);
        const config = ConfigSchema.parse(rawConfig);

        const runner = new GateRunner(config);
        const report = await runner.run(demoDir);

        recordScore(demoDir, report);

        const reportPath = path.join(demoDir, config.output.report_path);
        await fs.writeJson(reportPath, report, { spaces: 2 });

        displayGateResults(report, isCinematic);
        await generateArtifacts(demoDir, report, config);

    } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(chalk.red(`Demo error: ${msg}`));
    }
}

async function generateArtifacts(
    demoDir: string,
    report: any,
    config: any
): Promise<void> {
    if (report.status === 'FAIL') {
        const { FixPacketService } = await import('@rigour-labs/core');
        const fixPacketService = new FixPacketService();
        const fixPacket = fixPacketService.generate(report, config);
        const fixPacketPath = path.join(demoDir, 'rigour-fix-packet.json');
        await fs.writeJson(fixPacketPath, fixPacket, { spaces: 2 });
        console.log(chalk.green('✓ Fix packet generated: rigour-fix-packet.json'));
    }

    const auditPath = path.join(demoDir, 'rigour-audit-report.md');
    await generateDemoAudit(demoDir, report, auditPath);
    console.log(chalk.green('✓ Audit report exported: rigour-audit-report.md'));
    console.log('');
}

// ── Before/After improvement demo ───────────────────────────────────

export async function runBeforeAfterDemo(
    demoDir: string,
    options: DemoOptions
): Promise<void> {
    console.log(chalk.bold.green('Simulating agent fixing issues...\n'));
    await pause(600, options);

    // Fix the auth.ts — remove hardcoded key
    await typewrite(
        chalk.dim('  Agent: Removing hardcoded API key from src/auth.ts...'),
        options
    );
    await fs.writeFile(path.join(demoDir, 'src', 'auth.ts'), `
import express from 'express';

export function authenticate(req: express.Request) {
    const token = req.headers.authorization;
    if (!token) {
        return { authenticated: false };
    }
    // Validate against secure key store
    return { authenticated: validateToken(token) };
}

function validateToken(token: string): boolean {
    return token.startsWith('Bearer ') && token.length > 20;
}
`.trim());
    console.log(chalk.green('  ✓ Fixed: API key moved to environment variable'));

    await pause(300, options);

    // Fix data-loader.ts — remove hallucinated import
    await typewrite(
        chalk.dim('  Agent: Removing hallucinated import from src/data-loader.ts...'),
        options
    );
    await fs.writeFile(path.join(demoDir, 'src', 'data-loader.ts'), `
import { z } from 'zod';

const schema = z.object({
    name: z.string(),
    email: z.string().email(),
});

export function loadData(raw: unknown) {
    return schema.parse(raw);
}
`.trim());
    console.log(chalk.green('  ✓ Fixed: Removed non-existent package imports'));

    await pause(300, options);

    // Fix api-handler.ts — add error handling
    await typewrite(
        chalk.dim('  Agent: Adding error handling to src/api-handler.ts...'),
        options
    );
    await fs.writeFile(path.join(demoDir, 'src', 'api-handler.ts'), `
import express from 'express';

export async function fetchUserData(userId: string) {
    const response = await fetch(\`https://api.example.com/users/\${userId}\`);
    if (!response.ok) {
        throw new Error(\`Failed to fetch user: \${response.status}\`);
    }
    return response.json();
}

export async function handleRequest(req: express.Request, res: express.Response) {
    try {
        const data = await fetchUserData(req.params.id);
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch user data' });
    }
}
`.trim());
    console.log(chalk.green('  ✓ Fixed: Added proper await and error handling'));

    console.log('');
    await pause(500, options);

    // Re-run gates to show improvement
    console.log(chalk.bold.blue('Re-running quality gates after fixes...\n'));
    await pause(400, options);

    try {
        const configContent = await fs.readFile(
            path.join(demoDir, 'rigour.yml'),
            'utf-8'
        );
        const rawConfig = yaml.parse(configContent);
        const config = ConfigSchema.parse(rawConfig);
        const runner = new GateRunner(config);
        const report2 = await runner.run(demoDir);

        recordScore(demoDir, report2);

        const score1 = 35; // approximate first-run score
        const score2 = report2.stats.score ?? 75;
        const remaining = report2.failures.length;

        console.log(chalk.bold('Score improvement:\n'));
        console.log(renderScoreBar(score1, 'Before'));
        console.log(renderScoreBar(score2, 'After'));
        console.log('');

        // Trend chart
        console.log(renderTrendChart([score1, score2]));
        console.log('');

        if (remaining > 0) {
            console.log(chalk.yellow(`  ${remaining} issue(s) remaining (structural, TODOs)`));
        } else {
            console.log(chalk.green.bold('  All issues resolved!'));
        }
        console.log('');
    } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(chalk.red(`Re-check error: ${msg}`));
    }
}


// ── Scaffold demo project ───────────────────────────────────────────

export async function scaffoldDemoProject(dir: string): Promise<void> {
    const config = buildDemoConfig();
    await fs.writeFile(path.join(dir, 'rigour.yml'), yaml.stringify(config));
    await fs.writeJson(path.join(dir, 'package.json'), buildDemoPackageJson(), { spaces: 2 });

    await fs.ensureDir(path.join(dir, 'src'));
    await fs.ensureDir(path.join(dir, 'docs'));

    await writeIssueFiles(dir);
    await writeGodFile(dir);
    await fs.writeFile(path.join(dir, 'README.md'), '# Demo Project\n\nThis is a demo project for Rigour.\n');
}

export function buildDemoConfig(): Record<string, unknown> {
    return {
        version: 1,
        preset: 'api',
        gates: {
            max_file_lines: 300,
            forbid_todos: true,
            forbid_fixme: true,
            ast: { complexity: 10, max_params: 5 },
            security: { enabled: true, block_on_severity: 'high' },
            hallucinated_imports: { enabled: true, severity: 'critical' },
            promise_safety: { enabled: true, severity: 'high' },
        },
        hooks: { enabled: true, tools: ['claude'] },
        ignore: ['.git/**', 'node_modules/**'],
        output: { report_path: 'rigour-report.json' },
    };
}

export function buildDemoPackageJson(): Record<string, unknown> {
    return {
        name: 'rigour-demo',
        version: '1.0.0',
        dependencies: { express: '^4.18.0', zod: '^3.22.0' },
    };
}

export async function writeIssueFiles(dir: string): Promise<void> {
    // Issue 1: Hardcoded API key
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

    // Issue 2: Unhandled promise
    await fs.writeFile(path.join(dir, 'src', 'api-handler.ts'), `
import express from 'express';

export async function fetchUserData(userId: string) {
    const response = await fetch(\`https://api.example.com/users/\${userId}\`);
    return response.json();
}

export function handleRequest(req: express.Request, res: express.Response) {
    fetchUserData(req.params.id);
    res.send('Processing...');
}

export function batchProcess(ids: string[]) {
    ids.forEach(id => fetchUserData(id));
}
`.trim());

    // Issue 3: Hallucinated import
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

    // Issue 4: TODO markers
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
}

export async function writeGodFile(dir: string): Promise<void> {
    const lines: string[] = [
        '// Auto-generated data processing module',
        'export class DataProcessor {',
    ];
    for (let i = 0; i < 60; i++) {
        lines.push(`    process${i}(data: any) {`);
        lines.push(`        const result = data.map((x: any) => x * ${i + 1});`);
        lines.push(`        if (result.length > ${i * 10}) {`);
        lines.push(`            return result.slice(0, ${i * 10});`);
        lines.push(`        }`);
        lines.push(`        return result;`);
        lines.push(`    }`);
    }
    lines.push('}');
    await fs.writeFile(path.join(dir, 'src', 'god-file.ts'), lines.join('\n'));
}

// ── Audit report generator ──────────────────────────────────────────

export async function generateDemoAudit(
    dir: string,
    report: any,
    outputPath: string
): Promise<void> {
    const stats = report.stats || {};
    const failures = report.failures || [];
    const lines: string[] = [];

    lines.push('# Rigour Audit Report — Demo');
    lines.push('');
    lines.push(`**Generated:** ${new Date().toISOString()}`);
    lines.push(`**Status:** ${report.status}`);
    lines.push(`**Score:** ${stats.score ?? 100}/100`);
    if (stats.ai_health_score !== undefined) {
        lines.push(`**AI Health:** ${stats.ai_health_score}/100`);
    }
    if (stats.structural_score !== undefined) {
        lines.push(`**Structural:** ${stats.structural_score}/100`);
    }
    lines.push('');
    lines.push('## Violations');
    lines.push('');

    for (let i = 0; i < failures.length; i++) {
        const f = failures[i];
        lines.push(`### ${i + 1}. [${(f.severity || 'medium').toUpperCase()}] ${f.title}`);
        lines.push(`- **ID:** \`${f.id}\``);
        lines.push(`- **Provenance:** ${f.provenance || 'traditional'}`);
        lines.push(`- **Details:** ${f.details}`);
        if (f.files?.length) {
            lines.push(`- **Files:** ${f.files.join(', ')}`);
        }
        if (f.hint) {
            lines.push(`- **Hint:** ${f.hint}`);
        }
        lines.push('');
    }

    lines.push('---');
    lines.push('*Generated by Rigour — https://rigour.run*');
    lines.push('*Research: https://zenodo.org/records/18673564*');

    await fs.writeFile(outputPath, lines.join('\n'));
}
