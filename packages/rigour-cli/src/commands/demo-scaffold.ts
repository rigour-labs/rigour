import fs from 'fs-extra';
import path from 'path';
import chalk from 'chalk';
import yaml from 'yaml';

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
    await writeAuthFile(dir);
    await writeApiHandlerFile(dir);
    await writeDataLoaderFile(dir);
    await writeUtilsFile(dir);
}

async function writeAuthFile(dir: string): Promise<void> {
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
}

async function writeApiHandlerFile(dir: string): Promise<void> {
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
}

async function writeDataLoaderFile(dir: string): Promise<void> {
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
}

async function writeUtilsFile(dir: string): Promise<void> {
    await fs.writeFile(path.join(dir, 'src', 'utils.ts'), `
// NOTE: Claude suggested this but I need to review
// NOTE: This function has edge cases
export function formatDate(date: Date): string {
    return date.toISOString().split('T')[0];
}

export function sanitizeInput(input: string): string {
    // NOTE: Add proper sanitization
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
