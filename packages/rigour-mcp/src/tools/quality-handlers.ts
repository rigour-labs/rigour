/**
 * Quality Gate Tool Handlers
 *
 * Handlers for: rigour_check, rigour_explain, rigour_status,
 * rigour_get_fix_packet, rigour_list_gates, rigour_get_config
 *
 * @since v2.17.0 — extracted from monolithic index.ts
 */
import { GateRunner, Report } from "@rigour-labs/core";
import type { Config, DeepOptions } from "@rigour-labs/core";

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

    const report = await runner.run(cwd, fileTargets, deepOpts);
    const scoreText = formatScoreText(report.stats);
    const sevText = formatSeverityText(report.stats);
    const deepText = deepMode === 'off'
        ? ''
        : `\nDeep: ${deepMode} | Execution: ${execution.isLocal ? 'local' : 'cloud'}${report.stats.deep?.model ? ` | Model: ${report.stats.deep.model}` : ''}` +
          `${execution.isLocal
              ? '\nPrivacy: Local sidecar/model execution. Code remains on this machine.'
              : `\nPrivacy: Cloud provider execution. Code context may be sent to ${execution.provider} API.`}`;

    const result: ToolResult = {
        content: [{
            type: "text",
            text: `RIGOUR AUDIT RESULT: ${report.status}${scoreText}${sevText}${deepText}\n\nSummary:\n${Object.entries(report.summary).map(([k, v]) => `- ${k}: ${v}`).join("\n")}`,
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

    const { FixPacketService } = await import("@rigour-labs/core");
    const fixPacketService = new FixPacketService();
    const fixPacket = fixPacketService.generate(report, config);

    const packet = fixPacket.violations.map((v: any, i: number) => {
        const sevTag = `[${(v.severity || 'medium').toUpperCase()}]`;
        const catTag = v.category ? `(${v.category})` : '';
        let text = `FIX TASK ${i + 1}: ${sevTag} ${catTag} [${v.id.toUpperCase()}] ${v.title}\n`;
        text += `   - CONTEXT: ${v.details}\n`;
        if (v.files?.length > 0) text += `   - TARGET FILES: ${v.files.join(", ")}\n`;
        if (v.hint) text += `   - REFACTORING GUIDANCE: ${v.hint}\n`;
        return text;
    }).join("\n---\n");

    let scoreHeader = formatScoreText(report.stats).trim();
    if (scoreHeader) scoreHeader += '\n';

    return {
        content: [{
            type: "text",
            text: `ENGINEERING REFINEMENT REQUIRED:\n${scoreHeader}\nThe project state violated ${report.failures.length} quality gates. You MUST address these failures before declaring the task complete (critical issues first):\n\n${packet}`,
        }],
    };
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
