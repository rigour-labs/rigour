/**
 * Quality Gate Tool Handlers
 *
 * Handlers for: rigour_check, rigour_explain, rigour_status,
 * rigour_get_fix_packet, rigour_list_gates, rigour_get_config
 *
 * @since v2.17.0 — extracted from monolithic index.ts
 */
import { GateRunner, Report, renderMcpHeadline, renderFixAttribution } from "@rigour-labs/core";
import type { Config, DeepOptions } from "@rigour-labs/core";
import { notifyProgress } from '../utils/notifications.js';

type ToolResult = { content: { type: string; text: string }[]; isError?: boolean; _rigour_report?: Report };
type DeepMode = 'off' | 'quick' | 'full';

export interface CheckArgs {
    files?: string[];
    deep?: DeepMode;
    pro?: boolean;
    apiKey?: string;
    provider?: string;
    apiBaseUrl?: string;
    modelName?: string;
}

function resolveDeepExecution(args: CheckArgs): { isLocal: boolean; provider: string } {
    const requestedProvider = (args.provider || '').toLowerCase();
    const isForcedLocal = requestedProvider === 'local';
    const isLocal = !args.apiKey || isForcedLocal;
    return {
        isLocal,
        provider: isLocal ? 'local' : (args.provider || 'claude'),
    };
}

// ─── Score / Severity Formatters ──────────────────────────────────
function formatScoreText(stats: Report['stats']): string {
    let text = '';
    if (stats.score !== undefined) {
        text = `\nScore: ${stats.score}/100`;
        if (stats.ai_health_score !== undefined) text += ` | AI Health: ${stats.ai_health_score}/100`;
        if (stats.structural_score !== undefined) text += ` | Structural: ${stats.structural_score}/100`;
    }
    return text;
}

function formatSeverityText(stats: Report['stats']): string {
    if (!stats.severity_breakdown) return '';
    const parts = Object.entries(stats.severity_breakdown).filter(([, c]) => c > 0).map(([s, c]) => `${s}: ${c}`);
    return parts.length > 0 ? `\nSeverity: ${parts.join(', ')}` : '';
}

// ─── Handlers ─────────────────────────────────────────────────────

export async function handleCheck(runner: GateRunner, cwd: string, args: CheckArgs = {}): Promise<ToolResult> {
    const deepMode: DeepMode = args.deep || 'off';
    const fileTargets = args.files && args.files.length > 0 ? args.files : undefined;
    const execution = resolveDeepExecution(args);

    let deepOpts: DeepOptions | undefined;
    if (deepMode !== 'off') {
        deepOpts = {
            enabled: true,
            // full mode always means pro-depth analysis in MCP.
            pro: deepMode === 'full' ? true : !!args.pro,
            apiKey: args.apiKey,
            provider: execution.provider,
            apiBaseUrl: args.apiBaseUrl,
            modelName: args.modelName,
        };
    }

    notifyProgress("info", fileTargets ? `Scanning ${fileTargets.length} files...` : "Scanning project...");
    if (deepMode !== 'off') {
        notifyProgress("info", `Deep analysis: ${execution.isLocal ? 'local sidecar' : execution.provider} (${deepMode} mode)`);
    }

    const report = await runner.run(cwd, fileTargets, deepOpts);

    if (report.status === "PASS") {
        notifyProgress("info", `PASS \u2014 Score: ${report.stats.score ?? '?'}/100`);
    } else {
        const sev = report.stats.severity_breakdown || {};
        const sevParts = Object.entries(sev).filter(([, c]) => c > 0).map(([s, c]) => `${c} ${s}`).join(', ');
        notifyProgress("warning", `FAIL \u2014 ${sevParts || report.failures.length + ' violations'} (Score: ${report.stats.score ?? '?'}/100)`);
        const worst = report.failures.find(f => f.severity === 'critical') || report.failures[0];
        if (worst) notifyProgress("warning", `${worst.title}${worst.files?.[0] ? ' in ' + worst.files[0] : ''}`);
    }

    const scoreText = formatScoreText(report.stats);
    const sevText = formatSeverityText(report.stats);
    const deepText = deepMode === 'off'
        ? ''
        : `\nDeep: ${deepMode} | Execution: ${execution.isLocal ? 'local' : 'cloud'}${report.stats.deep?.model ? ` | Model: ${report.stats.deep.model}` : ''}` +
          `${execution.isLocal
              ? '\nPrivacy: Local sidecar/model execution. Code remains on this machine.'
              : `\nPrivacy: Cloud provider execution. Code context may be sent to ${execution.provider} API.`}`;

    // Human-facing headline — agents naturally pass this through to users
    const headline = renderMcpHeadline(report);

    const result: ToolResult = {
        content: [{
            type: "text",
            text: `${headline}\n\n${scoreText.trim()}${sevText}${deepText}\n\nSummary:\n${Object.entries(report.summary).map(([k, v]) => `- ${k}: ${v}`).join("\n")}`,
        }],
    };
    result._rigour_report = report;
    return result;
}

export async function handleExplain(runner: GateRunner, cwd: string): Promise<ToolResult> {
    const report = await runner.run(cwd);

    if (report.status === "PASS") {
        const passScore = report.stats.score !== undefined ? ` Score: ${report.stats.score}/100.` : '';
        return {
            content: [{ type: "text", text: `ALL QUALITY GATES PASSED.${passScore} No failures to explain.` }],
        };
    }

    let header = 'RIGOUR EXPLAIN:';
    header += formatScoreText(report.stats);
    header += formatSeverityText(report.stats);

    const bullets = report.failures.map((f, i) => {
        const sev = (f.severity || 'medium').toUpperCase();
        const prov = f.provenance ? ` (${f.provenance})` : '';
        return `${i + 1}. [${sev}] [${f.id.toUpperCase()}]${prov} ${f.title}: ${f.details}${f.hint ? ` (Hint: ${f.hint})` : ''}`;
    }).join("\n");

    return { content: [{ type: "text", text: `${header}\n\n${bullets}` }] };
}

export async function handleStatus(runner: GateRunner, cwd: string): Promise<ToolResult> {
    const report = await runner.run(cwd);
    return {
        content: [{
            type: "text",
            text: JSON.stringify({
                status: report.status,
                summary: report.summary,
                failureCount: report.failures.length,
                score: report.stats.score,
                ai_health_score: report.stats.ai_health_score,
                structural_score: report.stats.structural_score,
                severity_breakdown: report.stats.severity_breakdown,
                provenance_breakdown: report.stats.provenance_breakdown,
                durationMs: report.stats.duration_ms,
            }, null, 2),
        }],
    };
}

export async function handleGetFixPacket(runner: GateRunner, cwd: string, config: Config): Promise<ToolResult> {
    const report = await runner.run(cwd);

    if (report.status === "PASS") {
        const passScore = report.stats.score !== undefined ? ` Score: ${report.stats.score}/100.` : '';
        return {
            content: [{ type: "text", text: `ALL QUALITY GATES PASSED.${passScore} The current state meets the required engineering standards.` }],
        };
    }

    notifyProgress("info", `Generating fix packet for ${report.failures.length} violations...`);

    const { FixPacketService } = await import("@rigour-labs/core");
    const fixPacketService = new FixPacketService();
    const fixPacket = fixPacketService.generate(report, config);

    // Find worst violation for attribution
    const worst = report.failures.find(f => f.severity === 'critical')
        || report.failures.find(f => f.severity === 'high')
        || report.failures[0];
    const worstLabel = worst ? worst.title : 'quality violations';
    const attribution = renderFixAttribution(report.failures.length, worstLabel);

    return {
        content: [{ type: "text", text: formatFixPacketText(fixPacket, report) + attribution }],
    };
}

/**
 * Formats a FixPacketV2 into a structured, agent-readable text block.
 * Every violation includes: who failed, which files, what rule, where (line numbers),
 * and what commands must pass after fixing.
 */
function formatFixPacketText(fixPacket: any, report: Report): string {
    const lines: string[] = [];

    // Header
    let scoreHeader = formatScoreText(report.stats).trim();
    lines.push('ENGINEERING REFINEMENT REQUIRED');
    if (scoreHeader) lines.push(scoreHeader);
    lines.push(`Violations: ${report.failures.length} | Failed gates: ${fixPacket.failed_gates.join(', ')}`);
    lines.push('');

    // Violations
    fixPacket.violations.forEach((v: any, i: number) => {
        const sevTag = `[${(v.severity || 'medium').toUpperCase()}]`;
        const catTag = v.category ? ` (${v.category})` : '';
        lines.push(`━━━ FIX ${i + 1}/${fixPacket.violations.length}: ${sevTag}${catTag} ${v.title} ━━━`);
        lines.push(`GATE: ${v.id}`);
        lines.push(`PROBLEM: ${v.details}`);

        // Locations with line numbers (precise targeting)
        if (v.locations && v.locations.length > 0) {
            const locStrs = v.locations.map((loc: any) => {
                let s = loc.file;
                if (loc.line) s += `:${loc.line}`;
                if (loc.endLine && loc.endLine !== loc.line) s += `-${loc.endLine}`;
                return s;
            });
            lines.push(`WHERE: ${locStrs.join(', ')}`);
        } else if (v.files && v.files.length > 0) {
            lines.push(`FILES: ${v.files.join(', ')}`);
        }

        // Metrics (thresholds vs actuals)
        if (v.metrics && Object.keys(v.metrics).length > 0) {
            const metricStrs = Object.entries(v.metrics).map(([k, val]) => `${k}=${val}`);
            lines.push(`METRICS: ${metricStrs.join(', ')}`);
        }

        // Instructions
        if (v.instructions && v.instructions.length > 0) {
            lines.push(`FIX:`);
            v.instructions.forEach((inst: string, j: number) => {
                lines.push(`  ${j + 1}. ${inst}`);
            });
        } else if (v.hint) {
            lines.push(`HINT: ${v.hint}`);
        }

        lines.push('');
    });

    // Verification commands
    if (fixPacket.verification?.commands?.length > 0) {
        lines.push('━━━ VERIFICATION (run these after fixing) ━━━');
        fixPacket.verification.commands.forEach((c: any) => {
            lines.push(`  $ ${c.cmd}  — ${c.purpose}`);
        });
        lines.push('');
    }

    // Constraints
    const c = fixPacket.constraints;
    if (c) {
        const constraintParts: string[] = [];
        if (c.allowed_scope?.length > 0) constraintParts.push(`ALLOWED SCOPE: ${c.allowed_scope.join(', ')}`);
        if (c.do_not_touch?.length > 0) constraintParts.push(`DO NOT TOUCH: ${c.do_not_touch.join(', ')}`);
        if (c.max_files_changed) constraintParts.push(`MAX FILES CHANGED: ${c.max_files_changed}`);
        if (c.no_new_deps) constraintParts.push('NO NEW DEPENDENCIES');
        if (c.paradigm) constraintParts.push(`PARADIGM: ${c.paradigm}`);
        if (constraintParts.length > 0) {
            lines.push('━━━ CONSTRAINTS ━━━');
            constraintParts.forEach(p => lines.push(`  ${p}`));
        }
    }

    return lines.join('\n');
}

export function handleListGates(config: Config): ToolResult {
    return {
        content: [{
            type: "text",
            text: `ACTIVE QUALITY GATES:\n\n${Object.entries(config.gates).map(([k, v]) => {
                if (typeof v === 'object' && v !== null) return `- ${k}: ${JSON.stringify(v)}`;
                return `- ${k}: ${v}`;
            }).join("\n")}`,
        }],
    };
}

export function handleGetConfig(config: Config): ToolResult {
    return { content: [{ type: "text", text: JSON.stringify(config, null, 2) }] };
}
