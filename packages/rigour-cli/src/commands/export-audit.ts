/**
 * export-audit command
 *
 * Generates a compliance audit package from the last gate check.
 * The artifact compliance officers hand to auditors.
 *
 * Formats: JSON (structured) or Markdown (human-readable)
 *
 * @since v2.17.0
 */

import fs from 'fs-extra';
import path from 'path';
import chalk from 'chalk';
import yaml from 'yaml';
import { getScoreHistory, getScoreTrend } from '@rigour-labs/core';

const CLI_VERSION = '2.0.0';

export interface ExportAuditOptions {
    format?: 'json' | 'md';
    output?: string;
    run?: boolean;
}

export async function exportAuditCommand(cwd: string, options: ExportAuditOptions = {}) {
    const format = options.format || 'json';
    const configPath = path.join(cwd, 'rigour.yml');
    let reportPath = path.join(cwd, 'rigour-report.json');

    // If --run, execute a fresh check first
    if (options.run) {
        console.log(chalk.blue('Running fresh rigour check...\n'));
        const { checkCommand } = await import('./check.js');
        try {
            await checkCommand(cwd, [], {});
        } catch {
            // checkCommand calls process.exit, so we catch here for the --run flow
        }
    }

    // Read config
    let config: any = {};
    if (await fs.pathExists(configPath)) {
        try {
            const configContent = await fs.readFile(configPath, 'utf-8');
            config = yaml.parse(configContent);
            if (config?.output?.report_path) {
                reportPath = path.join(cwd, config.output.report_path);
            }
        } catch { }
    }

    // Read report
    if (!(await fs.pathExists(reportPath))) {
        console.error(chalk.red(`Error: No report found at ${reportPath}`));
        console.error(chalk.dim('Run `rigour check` first, or use `rigour export-audit --run`.'));
        process.exit(2);
    }

    let report: any;
    try {
        const reportContent = await fs.readFile(reportPath, 'utf-8');
        report = JSON.parse(reportContent);
    } catch (error: any) {
        console.error(chalk.red(`Error reading report: ${error.message}`));
        process.exit(3);
    }

    // Build audit package
    const auditPackage = buildAuditPackage(cwd, report, config);

    // Determine output path
    const outputPath = options.output
        ? path.resolve(cwd, options.output)
        : path.join(cwd, `rigour-audit-report.${format}`);

    // Write output
    if (format === 'md') {
        const markdown = renderMarkdown(auditPackage);
        await fs.writeFile(outputPath, markdown, 'utf-8');
    } else {
        await fs.writeJson(outputPath, auditPackage, { spaces: 2 });
    }

    console.log(chalk.green(`\n✔ Audit report exported: ${path.relative(cwd, outputPath)}`));
    console.log(chalk.dim(`  Format: ${format.toUpperCase()} | Status: ${auditPackage.summary.status} | Score: ${auditPackage.summary.score}/100`));
}

function buildAuditPackage(cwd: string, report: any, config: any) {
    const stats = report.stats || {};
    const failures = report.failures || [];

    // Score trend
    const trend = getScoreTrend(cwd);
    const history = getScoreHistory(cwd, 5);

    // Severity breakdown
    const severityBreakdown = stats.severity_breakdown || {};
    const provenanceBreakdown = stats.provenance_breakdown || {};

    // Gate results from summary
    const gateResults = Object.entries(report.summary || {}).map(([gate, status]) => ({
        gate,
        status: status as string,
    }));

    // Top violations
    const violations = failures.map((f: any) => ({
        id: f.id,
        severity: f.severity || 'medium',
        provenance: f.provenance || 'traditional',
        title: f.title,
        details: f.details,
        files: f.files || [],
        line: f.line,
        hint: f.hint,
    }));

    return {
        schema_version: '1.0.0',
        metadata: {
            project: path.basename(cwd),
            rigour_version: CLI_VERSION,
            timestamp: new Date().toISOString(),
            preset: config.preset || 'custom',
            config_path: 'rigour.yml',
            generated_by: 'rigour export-audit',
        },
        summary: {
            status: report.status,
            score: stats.score ?? 100,
            ai_health_score: stats.ai_health_score,
            structural_score: stats.structural_score,
            duration_ms: stats.duration_ms,
            total_violations: failures.length,
        },
        severity_breakdown: {
            critical: severityBreakdown.critical || 0,
            high: severityBreakdown.high || 0,
            medium: severityBreakdown.medium || 0,
            low: severityBreakdown.low || 0,
            info: severityBreakdown.info || 0,
        },
        provenance_breakdown: {
            'ai-drift': provenanceBreakdown['ai-drift'] || 0,
            traditional: provenanceBreakdown.traditional || 0,
            security: provenanceBreakdown.security || 0,
            governance: provenanceBreakdown.governance || 0,
        },
        gate_results: gateResults,
        violations,
        score_trend: trend ? {
            direction: trend.direction,
            delta: trend.delta,
            recent_average: trend.recentAvg,
            previous_average: trend.previousAvg,
            last_scores: trend.recentScores,
        } : null,
        recent_history: history.map(h => ({
            timestamp: h.timestamp,
            score: h.score,
            status: h.status,
        })),
    };
}

function renderMarkdown(audit: any): string {
    const lines: string[] = [];

    lines.push(`# Rigour Audit Report`);
    lines.push('');
    lines.push(`**Project:** ${audit.metadata.project}`);
    lines.push(`**Generated:** ${audit.metadata.timestamp}`);
    lines.push(`**Rigour Version:** ${audit.metadata.rigour_version}`);
    lines.push(`**Preset:** ${audit.metadata.preset}`);
    lines.push('');

    // Summary
    lines.push('## Summary');
    lines.push('');
    const statusEmoji = audit.summary.status === 'PASS' ? '✅' : '🛑';
    lines.push(`| Metric | Value |`);
    lines.push(`|:-------|:------|`);
    lines.push(`| **Status** | ${statusEmoji} ${audit.summary.status} |`);
    lines.push(`| **Overall Score** | ${audit.summary.score}/100 |`);
    if (audit.summary.ai_health_score !== undefined) {
        lines.push(`| **AI Health Score** | ${audit.summary.ai_health_score}/100 |`);
    }
    if (audit.summary.structural_score !== undefined) {
        lines.push(`| **Structural Score** | ${audit.summary.structural_score}/100 |`);
    }
    lines.push(`| **Total Violations** | ${audit.summary.total_violations} |`);
    lines.push(`| **Duration** | ${audit.summary.duration_ms}ms |`);
    lines.push('');

    // Severity Breakdown
    lines.push('## Severity Breakdown');
    lines.push('');
    lines.push('| Severity | Count |');
    lines.push('|:---------|:------|');
    for (const [sev, count] of Object.entries(audit.severity_breakdown)) {
        if ((count as number) > 0) {
            lines.push(`| ${(sev as string).charAt(0).toUpperCase() + (sev as string).slice(1)} | ${count} |`);
        }
    }
    lines.push('');

    // Provenance Breakdown
    lines.push('## Provenance Breakdown');
    lines.push('');
    lines.push('| Category | Count |');
    lines.push('|:---------|:------|');
    for (const [prov, count] of Object.entries(audit.provenance_breakdown)) {
        if ((count as number) > 0) {
            lines.push(`| ${prov} | ${count} |`);
        }
    }
    lines.push('');

    // Gate Results
    lines.push('## Gate Results');
    lines.push('');
    lines.push('| Gate | Status |');
    lines.push('|:-----|:-------|');
    for (const gate of audit.gate_results) {
        const icon = gate.status === 'PASS' ? '✅' : gate.status === 'FAIL' ? '❌' : '⏭️';
        lines.push(`| ${gate.gate} | ${icon} ${gate.status} |`);
    }
    lines.push('');

    // Violations
    if (audit.violations.length > 0) {
        lines.push('## Violations');
        lines.push('');
        for (let i = 0; i < audit.violations.length; i++) {
            const v = audit.violations[i];
            lines.push(`### ${i + 1}. [${v.severity.toUpperCase()}] ${v.title}`);
            lines.push('');
            lines.push(`- **ID:** \`${v.id}\``);
            lines.push(`- **Severity:** ${v.severity}`);
            lines.push(`- **Provenance:** ${v.provenance}`);
            lines.push(`- **Details:** ${v.details}`);
            if (v.files && v.files.length > 0) {
                lines.push(`- **Files:** ${v.files.join(', ')}`);
            }
            if (v.hint) {
                lines.push(`- **Hint:** ${v.hint}`);
            }
            lines.push('');
        }
    }

    // Score Trend
    if (audit.score_trend) {
        lines.push('## Score Trend');
        lines.push('');
        const arrow = audit.score_trend.direction === 'improving' ? '↑' :
                      audit.score_trend.direction === 'degrading' ? '↓' : '→';
        lines.push(`**Direction:** ${audit.score_trend.direction} ${arrow}`);
        lines.push(`**Recent Average:** ${audit.score_trend.recent_average}/100`);
        lines.push(`**Previous Average:** ${audit.score_trend.previous_average}/100`);
        lines.push(`**Delta:** ${audit.score_trend.delta > 0 ? '+' : ''}${audit.score_trend.delta}`);
        lines.push(`**Recent Scores:** ${audit.score_trend.last_scores.join(' → ')}`);
        lines.push('');
    }

    // Footer
    lines.push('---');
    lines.push(`*Generated by Rigour v${audit.metadata.rigour_version} — ${audit.metadata.timestamp}*`);
    lines.push('');

    return lines.join('\n');
}
