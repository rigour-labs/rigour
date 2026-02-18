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
} from '@rigour-labs/core';

// Exit codes per spec
const EXIT_PASS = 0;
const EXIT_FAIL = 1;
const EXIT_CONFIG_ERROR = 2;
const EXIT_INTERNAL_ERROR = 3;

export interface ScanOptions {
    ci?: boolean;
    json?: boolean;
    config?: string;
}

type ScanMode = 'existing-config' | 'auto-discovered';

interface ScanContext {
    mode: ScanMode;
    config: Config;
    configPath?: string;
    detectedPreset?: string;
    detectedParadigm?: string;
}

interface StackSignals {
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

        if (!options.ci && !options.json) {
            renderScanHeader(scanCtx, stackSignals);
        }

        const runner = new GateRunner(scanCtx.config);
        const report = await runner.run(cwd, files.length > 0 ? files : undefined);

        // Write machine report and score history
        const reportPath = path.join(cwd, scanCtx.config.output.report_path);
        await fs.writeJson(reportPath, report, { spaces: 2 });
        recordScore(cwd, report);

        // Generate fix packet on failure
        if (report.status === 'FAIL') {
            const fixPacketService = new FixPacketService();
            const fixPacket = fixPacketService.generate(report, scanCtx.config);
            const fixPacketPath = path.join(cwd, 'rigour-fix-packet.json');
            await fs.writeJson(fixPacketPath, fixPacket, { spaces: 2 });
        }

        if (options.json) {
            process.stdout.write(JSON.stringify({
                mode: scanCtx.mode,
                preset: scanCtx.detectedPreset ?? scanCtx.config.preset,
                paradigm: scanCtx.detectedParadigm ?? scanCtx.config.paradigm,
                stack: stackSignals,
                report,
            }, null, 2) + '\n');
            process.exit(report.status === 'PASS' ? EXIT_PASS : EXIT_FAIL);
        }

        if (options.ci) {
            const score = report.stats.score ?? 0;
            if (report.status === 'PASS') {
                console.log(`PASS (${score}/100)`);
            } else {
                console.log(`FAIL: ${report.failures.length} violation(s) | Score: ${score}/100`);
            }
            process.exit(report.status === 'PASS' ? EXIT_PASS : EXIT_FAIL);
        }

        renderScanResults(report, stackSignals, scanCtx.config.output.report_path, cwd);
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

function renderScanHeader(scanCtx: ScanContext, stackSignals: StackSignals): void {
    console.log(chalk.bold.cyan('\nRigour Scan'));
    console.log(chalk.dim('Zero-config security and AI-drift sweep using existing Rigour gates.\n'));

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
    const fakePackages = extractHallucinatedImports(report.failures);

    if (fakePackages.length > 0) {
        const unique = [...new Set(fakePackages)];
        console.log(chalk.red.bold(`oh shit: ${unique.length} fake package/path import(s) detected`));
        console.log(chalk.dim(`Examples: ${unique.slice(0, 5).join(', ')}${unique.length > 5 ? ', ...' : ''}`));
        console.log('');
    }

    const statusColor = report.status === 'PASS' ? chalk.green.bold : chalk.red.bold;
    const statusLabel = report.status === 'PASS' ? 'PASS' : 'FAIL';
    const score = report.stats.score ?? 0;
    const aiHealth = report.stats.ai_health_score ?? 0;
    const structural = report.stats.structural_score ?? 0;

    console.log(statusColor(`${statusLabel} | Score ${score}/100 | AI Health ${aiHealth}/100 | Structural ${structural}/100`));

    const severity = report.stats.severity_breakdown || {};
    const sevParts = ['critical', 'high', 'medium', 'low', 'info']
        .filter(level => (severity[level] || 0) > 0)
        .map(level => `${level}: ${severity[level]}`);
    if (sevParts.length > 0) {
        console.log(`Severity: ${sevParts.join(', ')}`);
    }

    renderCoverageWarnings(stackSignals);
    console.log('');

    if (report.status === 'FAIL') {
        const topFindings = report.failures.slice(0, 8);
        for (const failure of topFindings) {
            const sev = (failure.severity || 'medium').toUpperCase().padEnd(8, ' ');
            console.log(`${sev} [${failure.id}] ${failure.title}`);
            if (failure.files && failure.files.length > 0) {
                console.log(chalk.dim(`  files: ${failure.files.slice(0, 3).join(', ')}`));
            }
        }

        if (report.failures.length > topFindings.length) {
            console.log(chalk.dim(`...and ${report.failures.length - topFindings.length} more findings`));
        }
    }

    const trend = getScoreTrend(cwd);
    if (trend && trend.recentScores.length >= 3) {
        console.log(chalk.dim(`\nTrend: ${trend.recentScores.join(' -> ')} (${trend.direction})`));
    }

    console.log(chalk.yellow(`\nFull report: ${reportPath}`));
    if (report.status === 'FAIL') {
        console.log(chalk.yellow('Fix packet: rigour-fix-packet.json'));
    }
    console.log(chalk.dim(`Finished in ${report.stats.duration_ms}ms`));
}

function renderCoverageWarnings(stackSignals: StackSignals): void {
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

function extractHallucinatedImports(failures: Failure[]): string[] {
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
