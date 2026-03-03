import chalk from 'chalk';
import type { Failure, Report, Config } from '@rigour-labs/core';
import { getScoreTrend, resolveDeepOptions } from '@rigour-labs/core';
import type { DeepOptions } from '@rigour-labs/core';
import type { ScanOptions, StackSignals } from './scan.js';
import { extractHallucinatedImports, renderCoverageWarnings } from './scan.js';

export function buildDeepOpts(options: ScanOptions, isSilent: boolean): DeepOptions & { onProgress?: (msg: string) => void } {
    const resolved = resolveDeepOptions({
        apiKey: options.apiKey,
        provider: options.provider,
        apiBaseUrl: options.apiBaseUrl,
        modelName: options.modelName,
    });
    const hasApiKey = !!resolved.apiKey;
    const agentCount = Math.max(1, parseInt(options.agents || '1', 10) || 1);

    return {
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
}

export function persistDeepResults(cwd: string, report: Report, isDeep: boolean, options: ScanOptions): void {
    if (!isDeep) return;
    try {
        import('@rigour-labs/core').then(({ openDatabase, insertScan, insertFindings }) => {
            const db = openDatabase();
            if (!db) return;
            const repoName = require('path').basename(cwd);
            const scanId = insertScan(db, repoName, report, {
                deepTier: (report as any).stats.deep?.tier || (options.pro ? 'pro' : 'deep'),
                deepModel: (report as any).stats.deep?.model,
            });
            insertFindings(db, scanId, report.failures);
            db.close();
        }).catch(() => { /* silent */ });
    } catch { /* silent */ }
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

export function renderDeepScanResults(report: Report, stackSignals: StackSignals, config: Config, cwd: string): void {
    const stats = report.stats as any;
    const aiHealth = stats.ai_health_score ?? 100;
    const codeQuality = stats.code_quality_score ?? stats.structural_score ?? 100;
    const overall = stats.score ?? 100;
    const scoreColor = (s: number) => s >= 80 ? chalk.green : s >= 60 ? chalk.yellow : chalk.red;

    console.log(`  ${chalk.bold('AI Health:')}     ${scoreColor(aiHealth).bold(aiHealth + '/100')}`);
    console.log(`  ${chalk.bold('Code Quality:')}  ${scoreColor(codeQuality).bold(codeQuality + '/100')}`);
    console.log(`  ${chalk.bold('Overall:')}       ${scoreColor(overall).bold(overall + '/100')}`);
    console.log('');

    const isLocal = stats.deep?.tier ? stats.deep.tier !== 'cloud' : true;
    if (isLocal) {
        console.log(chalk.green('  🔒 Local sidecar execution. Code remains on this machine.'));
    } else {
        console.log(chalk.yellow(`  ☁️  Cloud execution. Code context sent to ${stats.deep?.tier || 'cloud'} API.`));
    }
    if (stats.deep) {
        const model = stats.deep.model || 'unknown';
        const ms = stats.deep.total_ms ? ` ${(stats.deep.total_ms / 1000).toFixed(1)}s` : '';
        console.log(chalk.dim(`  Model: ${model} (${stats.deep.tier})${ms}`));
    }
    console.log('');

    renderScaryHeadlines(report.failures);
    renderCategorizedFindings(report.failures);
    renderCoverageWarnings(stackSignals);

    const trend = getScoreTrend(cwd);
    if (trend && trend.recentScores.length >= 3) {
        const arrow = trend.direction === 'improving' ? '↑' : trend.direction === 'degrading' ? '↓' : '→';
        const color = trend.direction === 'improving' ? chalk.green : trend.direction === 'degrading' ? chalk.red : chalk.dim;
        console.log(color(`\nTrend: ${trend.recentScores.join(' → ')} ${arrow}`));
    }

    console.log(chalk.yellow(`\nFull report: ${config.output.report_path}`));
    if (report.status === 'FAIL') {
        console.log(chalk.yellow('Fix packet:  rigour-fix-packet.json'));
    }
    console.log(chalk.dim(`Finished in ${(stats.duration_ms / 1000).toFixed(1)}s | Score: ${overall}/100`));
    console.log('');

    if (report.status === 'FAIL') {
        console.log(chalk.bold('Next steps:'));
        console.log(`  ${chalk.cyan('rigour explain')}      — plain-English fix suggestions`);
        console.log(`  ${chalk.cyan('rigour init')}         — add quality gates to your project`);
    } else {
        console.log(chalk.green.bold('✓ This repo is clean.'));
    }
}

function renderScaryHeadlines(failures: Failure[]): void {
    const secrets = failures.filter(f => f.id === 'security-patterns' && f.severity === 'critical');
    const fakeImports = extractHallucinatedImports(failures);
    const phantoms = failures.filter(f => f.id === 'phantom-apis');
    let count = 0;
    if (secrets.length > 0) {
        console.log(chalk.red.bold(`🔑 HARDCODED SECRETS: ${secrets.length} credential(s) exposed`));
        count++;
    }
    if (fakeImports.length > 0) {
        const unique = [...new Set(fakeImports)];
        console.log(chalk.red.bold(`📦 HALLUCINATED PACKAGES: ${unique.length} import(s) don't exist`));
        count++;
    }
    if (phantoms.length > 0) {
        console.log(chalk.red.bold(`👻 PHANTOM APIs: ${phantoms.length} call(s) to non-existent methods`));
        count++;
    }
    if (count > 0) console.log('');
}

function renderCategorizedFindings(failures: Failure[]): void {
    const deep = failures.filter((f: any) => f.provenance === 'deep-analysis');
    const aiDrift = failures.filter((f: any) => f.provenance === 'ai-drift');
    const security = failures.filter((f: any) => f.provenance === 'security');
    const other = failures.filter((f: any) =>
        f.provenance !== 'deep-analysis' && f.provenance !== 'ai-drift' && f.provenance !== 'security'
    );

    if (deep.length > 0) {
        console.log(chalk.bold(`  ── Deep Analysis (${deep.length} verified) ──\n`));
        for (const f of deep.slice(0, 6)) {
            const desc = (f.details || f.title).substring(0, 120);
            console.log(`  ${severityIcon(f.severity)} [${f.id}] ${f.files?.[0] || ''}`);
            console.log(`       ${desc}`);
            if (f.hint) console.log(`       → ${f.hint}`);
            console.log('');
        }
    }
    if (aiDrift.length > 0) {
        console.log(chalk.bold(`  ── AI Drift (${aiDrift.length}) ──\n`));
        for (const f of aiDrift.slice(0, 5)) {
            console.log(`  ${severityIcon(f.severity)} ${f.title}`);
            if (f.files?.length) console.log(chalk.dim(`       ${f.files.slice(0, 2).join(', ')}`));
            console.log('');
        }
    }
    if (security.length > 0) {
        console.log(chalk.bold(`  ── Security (${security.length}) ──\n`));
        for (const f of security.slice(0, 5)) {
            console.log(`  ${severityIcon(f.severity)} ${f.title}`);
            if (f.hint) console.log(chalk.cyan(`       ${f.hint}`));
            console.log('');
        }
    }
    if (other.length > 0) {
        console.log(chalk.bold(`  ── Quality (${other.length}) ──\n`));
        for (const f of other.slice(0, 5)) {
            console.log(`  ${severityIcon(f.severity)} [${f.id}] ${f.title}`);
            console.log('');
        }
    }
}
