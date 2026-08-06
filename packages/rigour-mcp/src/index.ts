#!/usr/bin/env node
/**
 * Rigour MCP Server — Entry Point
 *
 * Slim orchestration layer that wires tool definitions to handlers.
 * All business logic lives in focused modules under tools/ and utils/.
 *
 * @since v2.17.0 — refactored from 1,487-line monolith
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
    ListPromptsRequestSchema,
    GetPromptRequestSchema,
    ListResourcesRequestSchema,
    ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "crypto";
import { GateRunner } from "@rigour-labs/core";

// Utils
import { loadConfig, loadMcpSettings, logStudioEvent } from './utils/config.js';
import { bindServer } from './utils/notifications.js';
import { getMcpVersion } from './utils/package-version.js';

// Dashboard (MCP App)
import { DASHBOARD_URI, getDashboardHtml, pushTimelineEntry, updateScore } from './dashboard/index.js';

// Tool definitions & advertised registry
import { getAdvertisedToolDefinitions } from './advertised-tools.js';

// Tool handlers
import { handleCheck, handleExplain, handleStatus, handleGetFixPacket, handleListGates, handleGetConfig } from './tools/quality-handlers.js';
import { handleRemember, handleRecall, handleForget } from './tools/memory-handlers.js';
import { handleCheckPattern, handleSecurityAudit } from './tools/pattern-handlers.js';
import { handleRun, handleRunSupervised } from './tools/execution-handlers.js';
import { handleAgentRegister, handleCheckpoint, handleHandoff, handleAgentDeregister, handleHandoffAccept } from './tools/agent-handlers.js';
import { handleReview } from './tools/review-handler.js';
import { handleHooksCheck, handleHooksInit } from './tools/hooks-handler.js';
import { handleCheckDeep, handleDeepStats } from './tools/deep-handlers.js';
import { handleMcpGetSettings, handleMcpSetSettings } from './tools/mcp-settings-handler.js';
import { handleContextStats, handleTaskCost, handleCacheStats, handleContextExplain, handleContextScope } from './tools/context-handlers.js';
import { handleIndex } from './tools/index-handlers.js';
import { recordContextEvent, estimateTokenCount } from '@rigour-labs/core';

// ─── Server Setup ─────────────────────────────────────────────────

const server = new Server(
    { name: "rigour-mcp", version: getMcpVersion('5.3.2') },
    { capabilities: { tools: {}, prompts: {}, logging: {}, resources: {} } }
);

// Bind server for logging notifications from handlers
bindServer(server);

// ─── Tool Listing ─────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: getAdvertisedToolDefinitions(),
}));

// ─── Resource Listing (MCP App Dashboard) ────────────────────────

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [{
        uri: DASHBOARD_URI,
        name: "Rigour Governance Dashboard",
        description: "Real-time governance dashboard — quality scores, agent activity timeline, severity breakdown",
        mimeType: "text/html",
    }],
}));

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    if (request.params.uri === DASHBOARD_URI) {
        return {
            contents: [{
                uri: DASHBOARD_URI,
                mimeType: "text/html",
                text: getDashboardHtml(),
            }],
        };
    }
    throw new Error(`Unknown resource: ${request.params.uri}`);
});

// ─── Tool Dispatch ────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const cwd = (args as any)?.cwd || process.cwd();
    const requestId = randomUUID();

    try {
        await logStudioEvent(cwd, { type: "tool_call", requestId, tool: name, arguments: args });

        // ── Image DLP warning ──────────────────────────────
        // MCP args may contain base64 image data. Text DLP cannot scan images.
        const argsStr = JSON.stringify(args ?? {});
        const hasImageContent = /data:image\/|base64,[A-Za-z0-9+/=]{100,}/.test(argsStr);

        const config = await loadConfig(cwd);
        const runner = new GateRunner(config);
        let result: any;

        switch (name) {
            // Quality gates
            case "rigour_check": {
                const { files, deep, pro, apiKey, provider, apiBaseUrl, modelName } = args as any;
                const mcpSettings = await loadMcpSettings(cwd);
                result = await handleCheck(runner, cwd, {
                    files,
                    deep: deep ?? mcpSettings.deep_default_mode,
                    pro,
                    apiKey,
                    provider,
                    apiBaseUrl,
                    modelName,
                });
                break;
            }
            case "rigour_explain":       result = await handleExplain(runner, cwd); break;
            case "rigour_status":        result = await handleStatus(runner, cwd); break;
            case "rigour_get_fix_packet": result = await handleGetFixPacket(runner, cwd, config); break;
            case "rigour_list_gates":    result = handleListGates(config); break;
            case "rigour_get_config":    result = handleGetConfig(config); break;
            case "rigour_mcp_get_settings": result = await handleMcpGetSettings(cwd); break;
            case "rigour_mcp_set_settings": result = await handleMcpSetSettings(cwd, args as any); break;

            // Memory
            case "rigour_remember":      result = await handleRemember(cwd, (args as any).key, (args as any).value || (args as any).content); break;
            case "rigour_recall":        result = await handleRecall(cwd, (args as any).key); break;
            case "rigour_forget":        result = await handleForget(cwd, (args as any).key); break;

            // Pattern intelligence
            case "rigour_check_pattern": result = await handleCheckPattern(cwd, (args as any).name, (args as any).type, (args as any).intent, (args as any).file); break;
            case "rigour_security_audit": result = await handleSecurityAudit(cwd); break;

            // Execution
            case "rigour_run":           result = await handleRun(cwd, (args as any).command, requestId); break;
            case "rigour_run_supervised": {
                const { command, maxRetries = 3, dryRun = false } = args as any;
                result = await handleRunSupervised(runner, cwd, command, maxRetries, dryRun, requestId, config);
                break;
            }

            // Multi-agent governance
            case "rigour_agent_register": result = await handleAgentRegister(cwd, (args as any).agentId, (args as any).taskScope, requestId); break;
            case "rigour_checkpoint": {
                const { progressPct, filesChanged = [], summary, qualityScore, agentId, taskId } = args as any;
                result = await handleCheckpoint(cwd, progressPct, filesChanged, summary, qualityScore, requestId, agentId, taskId);
                break;
            }
            case "rigour_handoff": {
                const { fromAgentId, toAgentId, taskDescription, filesInScope = [], context = '', taskId } = args as any;
                result = await handleHandoff(cwd, fromAgentId, toAgentId, taskDescription, filesInScope, context, requestId, taskId);
                break;
            }
            case "rigour_agent_deregister": result = await handleAgentDeregister(cwd, (args as any).agentId, requestId); break;
            case "rigour_handoff_accept":   result = await handleHandoffAccept(cwd, (args as any).handoffId, (args as any).agentId, requestId); break;

            // Real-time hooks + DLP (v3.0 / v4.2)
            case "rigour_hooks_check": result = await handleHooksCheck(cwd, (args as any).files ?? [], (args as any).timeout, (args as any).text, (args as any).agent); break;
            case "rigour_hooks_init":  result = await handleHooksInit(cwd, (args as any).tool, (args as any).force, (args as any).dryRun, (args as any).dlp ?? true); break;

            // Deep analysis (v4.0+)
            case "rigour_check_deep": {
                const { pro, apiKey, provider, apiBaseUrl, modelName } = args as any;
                result = await handleCheckDeep(runner, cwd, config, { pro, apiKey, provider, apiBaseUrl, modelName });
                break;
            }
            case "rigour_deep_stats": result = await handleDeepStats(cwd, (args as any).limit); break;

            // Code review
            case "rigour_review": result = await handleReview(runner, cwd, (args as any).diff, (args as any).files); break;

            // Context Telemetry & Cost Tools
            case "rigour_context_stats":   result = await handleContextStats(cwd, (args as any).taskId); break;
            case "rigour_task_cost":       result = await handleTaskCost(cwd, (args as any).taskId); break;
            case "rigour_cache_stats":     result = await handleCacheStats(cwd); break;
            case "rigour_context_explain": result = await handleContextExplain(cwd, (args as any).target, (args as any).taskId); break;

            // Pattern index & scoped context
            case "rigour_index": {
                const { semantic, force, output } = args as any;
                result = await handleIndex(cwd, { semantic, force, output });
                break;
            }
            case "rigour_context_scope": {
                const { query, limit, taskId, agentId } = args as any;
                result = await handleContextScope(cwd, query, limit, taskId, agentId);
                break;
            }

            default:
                throw new Error(`Unknown tool: ${name}`);
        }

        // ── Context Telemetry Recording (honest — from handler _telemetry metadata) ──
        try {
            const telemetry = result?._telemetry;
            const resultText = Array.isArray(result?.content) ? result.content.map((c: any) => c.text || '').join('\n') : '';
            const returnedTokens = telemetry?.returnedTokens ?? estimateTokenCount(resultText);
            if (!telemetry?.skipRecording) {
                await recordContextEvent({
                    taskId: telemetry?.taskId
                        || (args as any)?.taskId
                        || (args as any)?.task_id,
                    agentId: telemetry?.agentId
                        || (args as any)?.agentId
                        || (args as any)?.agent_id,
                    toolName: name,
                    queryHash: telemetry?.queryHash,
                    cacheStatus: telemetry?.cacheStatus ?? 'none',
                    candidateTokens: telemetry?.candidateTokens ?? returnedTokens,
                    returnedTokens,
                    deduplicatedTokens: telemetry?.deduplicatedTokens ?? 0,
                }, cwd);
            }
        } catch {
            // non-blocking context telemetry logging
        }

        // ── Prepend image DLP warning if image content was detected ──
        if (hasImageContent && Array.isArray(result.content)) {
            result.content.unshift({
                type: "text",
                text: "⚠ DLP Notice: Image content detected in this request. Text-based credential scanning cannot analyze images. Avoid sharing screenshots containing API keys, tokens, or passwords.",
            });
        }

        await logStudioEvent(cwd, {
            type: "tool_response", requestId, tool: name, status: "success",
            content: result.content, _rigour_report: result._rigour_report,
        });

        // ─── Dashboard State + MCP App UI Hint ──────────────
        const report = result._rigour_report;
        const details = report
            ? `${report.status.toUpperCase()} — Score: ${report.stats?.score ?? '?'}/100`
            : "completed";
        pushTimelineEntry(name, result.isError ? "error" : "success", details);

        if (report?.stats) {
            updateScore(
                report.stats.score ?? 0,
                report.status === "PASS" ? "pass" : "fail",
                report.stats.severity_breakdown,
            );
        }

        // Attach UI hint for MCP-App-capable clients (Claude Desktop, VS Code, ChatGPT, Goose)
        if (!result.isError) {
            result._meta = { ui: { resourceUri: DASHBOARD_URI } };
        }

        // Notify clients that the dashboard resource has updated
        try {
            await server.notification({
                method: "notifications/resources/updated",
                params: { uri: DASHBOARD_URI },
            });
        } catch {
            // Client doesn't support resource notifications — fine
        }

        return result;

    } catch (error: any) {
        const errorResponse = {
            content: [{ type: "text", text: `RIGOUR ERROR: ${error.message}` }],
            isError: true,
        };

        await logStudioEvent(cwd, {
            type: "tool_response", requestId, tool: name,
            status: "error", error: error.message, content: errorResponse.content,
        });

        return errorResponse;
    }
});

// ─── Prompt Templates ────────────────────────────────────────────

import { PROMPT_DEFINITIONS } from './tools/prompts.js';

server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: PROMPT_DEFINITIONS,
}));

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const { name, arguments: promptArgs } = request.params;
    const cwd = (promptArgs as any)?.cwd || process.env.RIGOUR_CWD || process.cwd();
    const mcpSettings = await loadMcpSettings(cwd);
    const deepMode = mcpSettings.deep_default_mode;

    const prompt = PROMPT_DEFINITIONS.find((p: any) => p.name === name);
    if (!prompt) {
        throw new Error(`Unknown prompt: ${name}`);
    }

    // Generate dynamic messages based on prompt name
    switch (name) {
        case "rigour-setup": {
            return {
                description: prompt.description,
                messages: [
                    {
                        role: "user" as const,
                        content: {
                            type: "text" as const,
                            text: `Initialize Rigour quality gates for the project at ${cwd}. Run \`rigour_check\` to see current quality score, then use \`rigour_hooks_init\` to install real-time hooks for the detected AI coding tool. MCP default deep mode for \`rigour_check\` is "${deepMode}". Report the score breakdown (overall, AI health, structural) and any critical violations.`,
                        },
                    },
                ],
            };
        }
        case "rigour-fix-loop": {
            return {
                description: prompt.description,
                messages: [
                    {
                        role: "user" as const,
                        content: {
                            type: "text" as const,
                            text: `Run \`rigour_check\` on ${cwd}. MCP default deep mode for \`rigour_check\` is "${deepMode}". If the project FAILS, retrieve the fix packet with \`rigour_get_fix_packet\` and fix every violation in priority order (critical → high → medium → low). After each fix, re-run \`rigour_check\` to verify. Repeat until PASS. Do NOT skip any violation. Report progress after each iteration.`,
                        },
                    },
                ],
            };
        }
        case "rigour-security-review": {
            return {
                description: prompt.description,
                messages: [
                    {
                        role: "user" as const,
                        content: {
                            type: "text" as const,
                            text: `Perform a full security review on ${cwd}. First run \`rigour_security_audit\` for CVE checks on dependencies. Then run \`rigour_check\` (default deep mode "${deepMode}") and filter for security-provenance violations (hardcoded secrets, SQL injection, XSS, command injection, path traversal). Report all findings with severity, file locations, and remediation instructions.`,
                        },
                    },
                ],
            };
        }
        case "rigour-pre-commit": {
            return {
                description: prompt.description,
                messages: [
                    {
                        role: "user" as const,
                        content: {
                            type: "text" as const,
                            text: `Run a pre-commit quality check on ${cwd}. Execute \`rigour_check\` (default deep mode "${deepMode}") and \`rigour_hooks_check\` on all staged files. If any critical or high severity violations exist, list them and block the commit. For medium/low violations, warn but allow. Provide a one-line summary: PASS (safe to commit) or FAIL (must fix first).`,
                        },
                    },
                ],
            };
        }
        case "rigour-ai-health-report": {
            return {
                description: prompt.description,
                messages: [
                    {
                        role: "user" as const,
                        content: {
                            type: "text" as const,
                            text: `Generate an AI code health report for ${cwd}. Run \`rigour_check\` (default deep mode "${deepMode}") and focus on AI-drift provenance violations: hallucinated imports, duplication drift, context window artifacts, inconsistent error handling, and promise safety. Compare AI health score vs structural score. Provide a summary table of AI-specific issues and concrete next steps to improve the AI health score.`,
                        },
                    },
                ],
            };
        }
        case "rigour-deep-analysis": {
            return {
                description: prompt.description,
                messages: [
                    {
                        role: "user" as const,
                        content: {
                            type: "text" as const,
                            text: `Run \`rigour_check_deep\` on ${cwd} for a full deep code quality analysis. This uses the three-step pipeline: AST extracts facts → LLM interprets patterns → AST verifies findings. Report the AI Health score, Code Quality score, and Overall score. List all verified findings grouped by category (SOLID violations, code smells, architecture issues, test quality). For each finding, show the file, description, and suggestion. If any critical findings exist, prioritize them. End with concrete action items to improve the code quality score.`,
                        },
                    },
                ],
            };
        }
        default:
            throw new Error(`Unknown prompt: ${name}`);
    }
});

// ─── Start ────────────────────────────────────────────────────────

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Rigour MCP server v4.0.0 running on stdio");
}

main().catch((error) => {
    console.error("Fatal error in Rigour MCP server:", error);
    process.exit(1);
});
