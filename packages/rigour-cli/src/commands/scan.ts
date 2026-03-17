import fs from 'fs-extra';
import path from 'path';
import chalk from 'chalk';
import yaml from 'yaml';
import { globby } from 'globby';
import {
    GateRunner,
    ConfigSchema,
    type Config,
    type Failure,
    type Report,
    DiscoveryService,
    FixPacketService,
    recordScore,
    getScoreTrend,
    renderFullReport,
    type RenderOptions,
} from '@rigour-labs/core';
import { buildDeepOpts, renderDeepScanResults } from './scan-deep.js';

// Exit codes per spec
const EXIT_PASS = 0;
const EXIT_FAIL = 1;
const EXIT_CONFIG_ERROR = 2;
const EXIT_INTERNAL_ERROR = 3;

export interface ScanOptions {
    ci?: boolean;
    json?: boolean;
    config?: string;
    deep?: boolean;
    pro?: boolean;
    apiKey?: string;
    provider?: string;
    apiBaseUrl?: string;
    modelName?: string;
    agents?: string;
}

type ScanMode = 'existing-config' | 'auto-discovered';

interface ScanContext {
    mode: ScanMode;
    config: Config;
    configPath?: string;
    detectedPreset?: string;
    detectedParadigm?: string;
}

export interface StackSignals {
    languages: string[];
    hasDocker: boolean;
    hasTerraform: boolean;
    hasSql: boolean;
}

const LANGUAGE_PATTERNS: Record<string, string[]> = {
    'TypeScript': ['**/*.ts', '**/*.tsx'],
    'JavaScript': ['**/*.js', '**/*.jsx', '**/*.mjs', '**/*.cjs'],
    'Python': ['**/*.py'],
    'Go': ['**/*.go'],
    'Java': ['**/*.java'],
    'Kotlin': ['**/*.kt'],
    'C#': ['**/*.cs'],
    'Ruby': ['**/*.rb', '**/*.rake'],
    'Rust': ['**/*.rs'],
};

const COMMON_IGNORE = [
    '**/node_modules/**',
    '**/.git/**',
    '**/dist/**',
    '**/build/**',
    '**/.next/**',
    '**/coverage/**',
    '**/vendor/**',
    '**/.venv/**',
    '**/venv/**',
    '**/target/**',
    '**/.terraform/**',
    '**/*.min.js',
];

const HEADLINE_GATE_SUPPORT: Record<string, string[]> = {
    'hallucinated-imports': ['TypeScript', 'JavaScript', 'Python', 'Go', 'Ruby', 'C#', 'Rust', 'Java', 'Kotlin'],
    'phantom-apis': ['TypeScript', 'JavaScript', 'Python', 'Go', 'C#', 'Java', 'Kotlin'],
    'deprecated-apis': ['TypeScript', 'JavaScript', 'Python', 'Go', 'C#', 'Java', 'Kotlin'],
    'promise-safety': ['TypeScript', 'JavaScript', 'Python', 'Go', 'Ruby', 'C#'],
    'security-patterns': ['TypeScript', 'JavaScript', 'Python', 'Go', 'Java', 'Kotlin'],
    'duplication-drift': ['TypeScript', 'JavaScript', 'Python'],
    'inconsistent-error-handling': ['TypeScript', 'JavaScript'],
    'context-window-artifacts': ['TypeScript', 'JavaScript', 'Python'],
};

export async function scanCommand(cwd: string, files: string[] = [], options: ScanOptions = {}) {
    try {
        const scanCtx = await resolveScanConfig(cwd, options);
        const stackSignals = await detectStackSignals(cwd);
        const isDeep = !!options.deep || !!options.pro || !!options.apiKey;
        const isSilent = !!options.ci || !!options.json;

        if (!isSilent) {
            renderScanHeader(scanCtx, stackSignals, isDeep);
        }

        const runner = new GateRunner(scanCtx.config);
        const deepOpts = isDeep ? buildDeepOpts(options, isSilent) : undefined;
        const report = await runner.run(cwd, files.length > 0 ? files : undefined, deepOpts);

        await writeReportArtifacts(cwd, report, scanCtx.config);
        await writeLastScanJson(cwd, scanCtx, stackSignals, report, isDeep);
        if (options.json) {
            outputJson(scanCtx, stackSignals, report);
            return;
        }
        if (options.ci) {
            outputCi(report);
            return;
        }

        if (isDeep) {
            renderDeepScanResults(report, stackSignals, scanCtx.config, cwd);
        } else {
            renderScanResults(report, stackSignals, scanCtx.config.output.report_path, cwd);
        }
        process.exit(report.status === 'PASS' ? EXIT_PASS : EXIT_FAIL);
    } catch (error: any) {
        if (error.name === 'ZodError') {
            console.error(chalk.red('\nInvalid configuration for scan mode:'));
            error.issues.forEach((issue: any) => {
                console.error(chalk.red(`  • ${issue.path.join('.')}: ${issue.message}`));
            });
            process.exit(EXIT_CONFIG_ERROR);
        }
        console.error(chalk.red(`Internal error: ${error.message}`));
        process.exit(EXIT_INTERNAL_ERROR);
    }
}


async function writeReportArtifacts(cwd: string, report: Report, config: Config): Promise<void> {
    const reportPath = path.join(cwd, config.output.report_path);
    await fs.writeJson(reportPath, report, { spaces: 2 });
    recordScore(cwd, report);

    if (report.status === 'FAIL') {
        const fixPacketService = new FixPacketService();
        const fixPacket = fixPacketService.generate(report, config);
        await fs.writeJson(path.join(cwd, 'rigour-fix-packet.json'), fixPacket, { spaces: 2 });
    }
}


function outputJson(scanCtx: ScanContext, stackSignals: StackSignals, report: Report): void {
    process.stdout.write(JSON.stringify({
        mode: scanCtx.mode,
        preset: scanCtx.detectedPreset ?? scanCtx.config.preset,
        paradigm: scanCtx.detectedParadigm ?? scanCtx.config.paradigm,
        stack: stackSignals,
        report,
    }, null, 2) + '\n');
    process.exit(report.status === 'PASS' ? EXIT_PASS : EXIT_FAIL);
}

function outputCi(report: Report): void {
    const score = report.stats.score ?? 0;
    if (report.status === 'PASS') {
        console.log(`PASS (${score}/100)`);
    } else {
        console.log(`FAIL: ${report.failures.length} violation(s) | Score: ${score}/100`);
    }
    process.exit(report.status === 'PASS' ? EXIT_PASS : EXIT_FAIL);
}

async function resolveScanConfig(cwd: string, options: ScanOptions): Promise<ScanContext> {
    const explicitConfig = options.config ? path.resolve(cwd, options.config) : undefined;
    const defaultConfig = path.join(cwd, 'rigour.yml');
    const configPath = explicitConfig || defaultConfig;

    if (await fs.pathExists(configPath)) {
        const configContent = await fs.readFile(configPath, 'utf-8');
        const rawConfig = yaml.parse(configContent);
        const config = ConfigSchema.parse(rawConfig);
        return {
            mode: 'existing-config',
            config,
            configPath,
            detectedPreset: config.preset,
            detectedParadigm: config.paradigm,
        };
    }

    const discovery = new DiscoveryService();
    const discovered = await discovery.discover(cwd);
    return {
        mode: 'auto-discovered',
        config: ConfigSchema.parse(discovered.config),
        detectedPreset: discovered.matches.preset?.name,
        detectedParadigm: discovered.matches.paradigm?.name,
    };
}

async function detectStackSignals(cwd: string): Promise<StackSignals> {
    const languageChecks = await Promise.all(
        Object.entries(LANGUAGE_PATTERNS).map(async ([language, patterns]) => {
            const matches = await globby(patterns, { cwd, gitignore: true, ignore: COMMON_IGNORE });
            return { language, found: matches.length > 0 };
        })
    );

    const languages = languageChecks.filter(item => item.found).map(item => item.language);

    const [dockerMatches, terraformMatches, sqlMatches] = await Promise.all([
        globby(['**/Dockerfile', '**/docker-compose*.yml', '**/*.dockerfile'], { cwd, gitignore: true, ignore: COMMON_IGNORE }),
        globby(['**/*.tf', '**/*.tfvars', '**/*.hcl'], { cwd, gitignore: true, ignore: COMMON_IGNORE }),
        globby(['**/*.sql'], { cwd, gitignore: true, ignore: COMMON_IGNORE }),
    ]);

    return {
        languages,
        hasDocker: dockerMatches.length > 0,
        hasTerraform: terraformMatches.length > 0,
        hasSql: sqlMatches.length > 0,
    };
}

function renderScanHeader(scanCtx: ScanContext, stackSignals: StackSignals, isDeep = false): void {
    console.log(chalk.bold.cyan('\nRigour Scan') + (isDeep ? chalk.blue.bold(' + Deep Analysis') : ''));
    const desc = isDeep
        ? 'Zero-config sweep with LLM-powered deep analysis.'
        : 'Zero-config security and AI-drift sweep using existing Rigour gates.';
    console.log(chalk.dim(desc + '\n'));

    const modeLabel = scanCtx.mode === 'existing-config'
        ? `Using existing config: ${path.basename(scanCtx.configPath || 'rigour.yml')}`
        : 'Auto-discovered config (no rigour.yml required)';

    const preset = scanCtx.detectedPreset || scanCtx.config.preset || 'universal';
    const paradigm = scanCtx.detectedParadigm || scanCtx.config.paradigm || 'general';

    console.log(chalk.bold(`Mode:`) + ` ${modeLabel}`);
    console.log(chalk.bold(`Detected profile:`) + ` preset=${preset}, paradigm=${paradigm}`);
    console.log(chalk.bold(`Detected stack:`) + ` ${stackSignals.languages.join(', ') || 'No major language signatures detected'}`);
    console.log('');
}

function renderScanResults(report: Report, stackSignals: StackSignals, reportPath: string, cwd: string): void {
    // Build render options with Brain + trend data
    const trend = getScoreTrend(cwd);
    const renderOpts: RenderOptions = {
        showBrain: true,
        brainPatterns: 0,
        brainTrend: 'stable',
    };

    if (trend && trend.recentScores.length >= 3) {
        renderOpts.recentScores = trend.recentScores;
        renderOpts.brainTrend = trend.direction as 'improving' | 'degrading' | 'stable';
    }

    // Try to get Brain pattern count
    try {
        const dbPath = path.join(cwd, '.rigour', 'rigour.db');
        if (fs.existsSync(dbPath)) {
            renderOpts.brainPatterns = 1; // Indicate Brain is active (exact count comes from SQLite)
        }
    } catch { /* ignore */ }

    // Render the rich report
    console.log(renderFullReport(report, renderOpts));

    // Coverage warnings still relevant
    renderCoverageWarnings(stackSignals);

    console.log(chalk.dim(`\n  Report: ${reportPath}`));
    if (report.status === 'FAIL') {
        console.log(chalk.dim(`  Fix packet: rigour-fix-packet.json`));
    }
}


export function renderCoverageWarnings(stackSignals: StackSignals): void {
    const gaps: string[] = [];

    for (const language of stackSignals.languages) {
        const supportedBy = Object.entries(HEADLINE_GATE_SUPPORT)
            .filter(([, languages]) => languages.includes(language))
            .map(([gateId]) => gateId);

        if (supportedBy.length < 3) {
            gaps.push(`${language}: partial support (${supportedBy.join(', ') || 'none'})`);
        }
    }

    if (stackSignals.hasDocker || stackSignals.hasTerraform) {
        gaps.push('Infra files detected (Docker/Terraform) but no dedicated vulnerability/drift gate yet');
    }

    if (stackSignals.hasSql) {
        gaps.push('SQL files detected but no dedicated .sql static gate yet (string-level SQL checks only)');
    }

    if (gaps.length > 0) {
        console.log(chalk.yellow('Coverage gaps to close:'));
        gaps.forEach(gap => console.log(chalk.yellow(`  - ${gap}`)));
    }
}

export function extractHallucinatedImports(failures: Failure[]): string[] {
    const fakeImports: string[] = [];

    for (const failure of failures) {
        if (failure.id !== 'hallucinated-imports') continue;

        const matches = failure.details.matchAll(/import '([^']+)'/g);
        for (const match of matches) {
            fakeImports.push(match[1]);
        }
    }

    return fakeImports;
}


/**
 * Always write a comprehensive last-scan.json to .rigour/ for tooling and MCP consumption.
 * This file is written regardless of --json, --ci, or --deep flags.
 */
async function writeLastScanJson(
    cwd: string,
    scanCtx: ScanContext,
    stackSignals: StackSignals,
    report: Report,
    isDeep: boolean,
): Promise<void> {
    const rigourDir = path.join(cwd, '.rigour');
    await fs.ensureDir(rigourDir);
    const lastScanPath = path.join(rigourDir, 'last-scan.json');

    const severity = report.stats.severity_breakdown || {};
    const provenance = (report.stats as any).provenance_breakdown || {};

    const payload = {
        timestamp: new Date().toISOString(),
        mode: scanCtx.mode,
        preset: scanCtx.detectedPreset ?? scanCtx.config.preset,
        paradigm: scanCtx.detectedParadigm ?? scanCtx.config.paradigm,
        stack: stackSignals,
        deep: isDeep,
        status: report.status,
        scores: {
            overall: report.stats.score ?? 0,
            ai_health: report.stats.ai_health_score ?? 0,
            structural: report.stats.structural_score ?? 0,
            code_quality: (report.stats as any).code_quality_score ?? 0,
        },
        severity_breakdown: severity,
        provenance_breakdown: provenance,
        total_findings: report.failures.length,
        duration_ms: report.stats.duration_ms,
        deep_stats: (report.stats as any).deep || null,
        findings: report.failures.map(f => ({
            id: f.id,
            title: f.title,
            severity: f.severity ?? 'medium',
            provenance: (f as any).provenance ?? 'traditional',
            files: f.files || [],
            line: f.line,
            hint: f.hint,
            category: (f as any).category,
            verified: (f as any).verified,
            confidence: (f as any).confidence,
        })),
    };

    await fs.writeJson(lastScanPath, payload, { spaces: 2 });
}


