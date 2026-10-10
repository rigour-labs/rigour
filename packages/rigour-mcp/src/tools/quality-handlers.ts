/**
 * Quality Gate Tool Handlers
 *
 * Handlers for: rigour_check, rigour_explain, rigour_status,
 * rigour_get_fix_packet, rigour_list_gates, rigour_get_config
 *
 * @since v2.17.0 — extracted from monolithic index.ts
 */
import { GateRunner, Report, changeReview, renderMcpHeadline } from "@rigour-labs/core";
import type { ChangeReview, Config, DeepOptions } from "@rigour-labs/core";
import { notifyProgress } from '../utils/notifications.js';
import { DEFAULT_FIX_PACKET_PAGE_SIZE, FIX_PACKET_INSTRUCTION, MAX_FIX_PACKET_PAGE_SIZE, formatFixPacketPage } from './fix-packet-format.js';

/** The agent's change as the stop hook judges it; a parameter so tests need no repository. */
export type ReviewChange = (cwd: string, config: Config) => Promise<ChangeReview>;

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

/**
 * rigour_check. With no files and no model review it judges the agent's change by the rule the stop hook and the push
 * gate hold it to, so "FAIL" means the agent has something to fix, never old debt elsewhere. Named files, or a deep
 * review, check those files as they are.
 */
export async function handleCheck(runner: GateRunner, cwd: string, args: CheckArgs = {}, config?: Config, review: ReviewChange = changeReview): Promise<ToolResult> {
    const deepMode: DeepMode = args.deep || 'off';
    const fileTargets = args.files && args.files.length > 0 ? args.files : undefined;
    const execution = resolveDeepExecution(args);
    if (!fileTargets && deepMode === 'off' && config) return checkChange(cwd, config, review);

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

async function checkChange(cwd: string, config: Config, review: ReviewChange): Promise<ToolResult> {
    notifyProgress("info", "Checking your change...");
    const change = await review(cwd, config);
    const must = change.blocking.length;
    const notes = change.result.advisory.length + change.result.fileFindings.length;
    const verdict = must
        ? `FAIL: ${must} thing${must === 1 ? '' : 's'} to fix in your change (against ${change.against}); they block you at the stop hook and the push gate.`
        : `PASS: nothing in your change (against ${change.against}) blocks you.`;
    notifyProgress(must ? "warning" : "info", verdict);
    const text = [
        verdict,
        notes ? `Notes on your change, optional: ${notes}.` : '',
        must || notes ? `rigour_get_fix_packet lists them, must-fix first. ${FIX_PACKET_INSTRUCTION}` : '',
        change.result.preexisting ? `Not yours: ${change.result.preexisting} issue(s) the code already had before your change; leave them.` : '',
    ].filter(Boolean).join('\n');
    const result: ToolResult = { content: [{ type: 'text', text }] };
    if (change.result.report) result._rigour_report = change.result.report;
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

/** The agent's work order for its change: what blocks it, then the optional notes, by the stop hook's own rule. */
export async function handleGetFixPacket(
    cwd: string,
    config: Config,
    args: { offset?: number; limit?: number } = {},
    review: ReviewChange = changeReview,
): Promise<ToolResult> {
    const offset = args.offset ?? 0;
    const limit = args.limit ?? DEFAULT_FIX_PACKET_PAGE_SIZE;
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit)
        || limit < 1 || limit > MAX_FIX_PACKET_PAGE_SIZE) {
        return { isError: true, content: [{ type: 'text', text: 'offset must be a nonnegative integer and limit must be an integer from 1 to 10.' }] };
    }
    const change = await review(cwd, config);
    notifyProgress("info", `Fix packet: ${change.blocking.length} must fix in your change`);
    return { content: [{ type: "text", text: formatFixPacketPage(change, offset, limit) }] };
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
