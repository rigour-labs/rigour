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
} from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "crypto";
import { GateRunner } from "@rigour-labs/core";

// Utils
import { loadConfig, logStudioEvent } from './utils/config.js';

// Tool definitions
import { TOOL_DEFINITIONS } from './tools/definitions.js';

// Tool handlers
import { handleCheck, handleExplain, handleStatus, handleGetFixPacket, handleListGates, handleGetConfig } from './tools/quality-handlers.js';
import { handleRemember, handleRecall, handleForget } from './tools/memory-handlers.js';
import { handleCheckPattern, handleSecurityAudit } from './tools/pattern-handlers.js';
import { handleRun, handleRunSupervised } from './tools/execution-handlers.js';
import { handleAgentRegister, handleCheckpoint, handleHandoff, handleAgentDeregister, handleHandoffAccept } from './tools/agent-handlers.js';
import { handleReview } from './tools/review-handler.js';
import { handleHooksCheck, handleHooksInit } from './tools/hooks-handler.js';

// ─── Server Setup ─────────────────────────────────────────────────

const server = new Server(
    { name: "rigour-mcp", version: "3.0.0" },
    { capabilities: { tools: {} } }
);

// ─── Tool Listing ─────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS,
}));

// ─── Tool Dispatch ────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const cwd = (args as any)?.cwd || process.cwd();
    const requestId = randomUUID();

    try {
        await logStudioEvent(cwd, { type: "tool_call", requestId, tool: name, arguments: args });

        const config = await loadConfig(cwd);
        const runner = new GateRunner(config);
        let result: any;

        switch (name) {
            // Quality gates
            case "rigour_check":         result = await handleCheck(runner, cwd); break;
            case "rigour_explain":       result = await handleExplain(runner, cwd); break;
            case "rigour_status":        result = await handleStatus(runner, cwd); break;
            case "rigour_get_fix_packet": result = await handleGetFixPacket(runner, cwd, config); break;
            case "rigour_list_gates":    result = handleListGates(config); break;
            case "rigour_get_config":    result = handleGetConfig(config); break;

            // Memory
            case "rigour_remember":      result = await handleRemember(cwd, (args as any).key, (args as any).value); break;
            case "rigour_recall":        result = await handleRecall(cwd, (args as any).key); break;
            case "rigour_forget":        result = await handleForget(cwd, (args as any).key); break;

            // Pattern intelligence
            case "rigour_check_pattern": result = await handleCheckPattern(cwd, (args as any).name, (args as any).type, (args as any).intent); break;
            case "rigour_security_audit": result = await handleSecurityAudit(cwd); break;

            // Execution
            case "rigour_run":           result = await handleRun(cwd, (args as any).command, requestId); break;
            case "rigour_run_supervised": {
                const { command, maxRetries = 3, dryRun = false } = args as any;
                result = await handleRunSupervised(runner, cwd, command, maxRetries, dryRun, requestId);
                break;
            }

            // Multi-agent governance
            case "rigour_agent_register": result = await handleAgentRegister(cwd, (args as any).agentId, (args as any).taskScope, requestId); break;
            case "rigour_checkpoint": {
                const { progressPct, filesChanged = [], summary, qualityScore } = args as any;
                result = await handleCheckpoint(cwd, progressPct, filesChanged, summary, qualityScore, requestId);
                break;
            }
            case "rigour_handoff": {
                const { fromAgentId, toAgentId, taskDescription, filesInScope = [], context = '' } = args as any;
                result = await handleHandoff(cwd, fromAgentId, toAgentId, taskDescription, filesInScope, context, requestId);
                break;
            }
            case "rigour_agent_deregister": result = await handleAgentDeregister(cwd, (args as any).agentId, requestId); break;
            case "rigour_handoff_accept":   result = await handleHandoffAccept(cwd, (args as any).handoffId, (args as any).agentId, requestId); break;

            // Real-time hooks (v3.0)
            case "rigour_hooks_check": result = await handleHooksCheck(cwd, (args as any).files, (args as any).timeout); break;
            case "rigour_hooks_init":  result = await handleHooksInit(cwd, (args as any).tool, (args as any).force, (args as any).dryRun); break;

            // Code review
            case "rigour_review": result = await handleReview(runner, cwd, (args as any).diff, (args as any).files); break;

            default:
                throw new Error(`Unknown tool: ${name}`);
        }

        await logStudioEvent(cwd, {
            type: "tool_response", requestId, tool: name, status: "success",
            content: result.content, _rigour_report: result._rigour_report,
        });

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

// ─── Start ────────────────────────────────────────────────────────

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Rigour MCP server v3.0.0 running on stdio");
}

main().catch((error) => {
    console.error("Fatal error in Rigour MCP server:", error);
    process.exit(1);
});
