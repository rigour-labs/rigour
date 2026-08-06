/**
 * MCP tools advertised to clients via ListTools.
 *
 * Essential context/quality tools stay visible for day-to-day agent work.
 * Governance tools are included so Cursor and other MCP clients can discover
 * multi-agent registration, checkpoints, handoffs, hooks, and supervised runs
 * without hunting for undocumented callable tools.
 */
import { TOOL_DEFINITIONS } from './tools/definitions.js';

/** Context, quality, and cost telemetry tools every agent should see first. */
export const ESSENTIAL_CONTEXT_TOOLS = [
    'rigour_recall',
    'rigour_index',
    'rigour_context_scope',
    'rigour_check_pattern',
    'rigour_check',
    'rigour_remember',
    'rigour_explain',
    'rigour_get_fix_packet',
    'rigour_review',
    'rigour_security_audit',
    'rigour_forget',
    'rigour_context_stats',
    'rigour_task_cost',
    'rigour_cache_stats',
    'rigour_context_explain',
] as const;

/** Multi-agent governance, hooks, and execution tools with dispatch handlers. */
export const GOVERNANCE_TOOLS = [
    'rigour_agent_register',
    'rigour_agent_deregister',
    'rigour_checkpoint',
    'rigour_handoff',
    'rigour_handoff_accept',
    'rigour_hooks_check',
    'rigour_hooks_init',
    'rigour_run',
    'rigour_run_supervised',
] as const;

export const ADVERTISED_TOOLS = new Set<string>([
    ...ESSENTIAL_CONTEXT_TOOLS,
    ...GOVERNANCE_TOOLS,
]);

export function getAdvertisedToolDefinitions() {
    return TOOL_DEFINITIONS.filter(t => ADVERTISED_TOOLS.has(t.name));
}
