/**
 * MCP tools advertised to clients via ListTools.
 *
 * Every advertised tool costs every agent session its definition in context
 * and one more choice to get wrong, so the default is the core loop a single
 * agent needs. Other groups are opt-in through RIGOUR_MCP_TOOLS in the MCP
 * client's config, e.g. "governance,telemetry" or "full". A repository whose
 * rigour.yml turns on agent teams or checkpoints gets the governance group too,
 * since its gates expect agents to register and check in. Tools outside the
 * advertised set stay callable; they are just not listed.
 */
import fs from 'fs';
import path from 'path';
import yaml from 'yaml';
import { TOOL_DEFINITIONS } from './tools/definitions.js';

export const TOOL_GROUPS = {
    /** Load memory, scope context, avoid reinvention, gate and review the change, learn. */
    core: [
        'rigour_recall',
        'rigour_index',
        'rigour_context_scope',
        'rigour_check_pattern',
        'rigour_check',
        'rigour_review',
        'rigour_review_ack',
        'rigour_reviewer_verdict',
        'rigour_get_fix_packet',
        'rigour_remember',
    ],
    /** Multi-agent registration, checkpoints, handoffs, hooks and supervised runs. */
    governance: [
        'rigour_agent_register',
        'rigour_agent_deregister',
        'rigour_checkpoint',
        'rigour_handoff',
        'rigour_handoff_accept',
        'rigour_hooks_check',
        'rigour_hooks_init',
        'rigour_run',
        'rigour_run_supervised',
    ],
    /** Occasional context and security tools. */
    context: [
        'rigour_explain',
        'rigour_forget',
        'rigour_context_explain',
        'rigour_security_audit',
    ],
    /** Cost and cache telemetry, mostly for dashboards. */
    telemetry: [
        'rigour_context_stats',
        'rigour_task_cost',
        'rigour_cache_stats',
    ],
} as const;

export type ToolGroup = keyof typeof TOOL_GROUPS;
export const GOVERNANCE_TOOLS = TOOL_GROUPS.governance;

/** Tool names for a RIGOUR_MCP_TOOLS value; core is always included, unknown groups are ignored. */
export function advertisedToolNames(spec: string | undefined = process.env.RIGOUR_MCP_TOOLS): Set<string> {
    const requested = (spec ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    const groups = requested.includes('full') ? (Object.keys(TOOL_GROUPS) as ToolGroup[]) : ['core', ...requested];
    return new Set(groups.filter((g): g is ToolGroup => g in TOOL_GROUPS).flatMap(g => [...TOOL_GROUPS[g]]));
}

/** The repository's rigour.yml enables a gate that needs the governance tools (agent_team, checkpoint). */
function repoNeedsGovernance(cwd: string): boolean {
    try {
        const gates = yaml.parse(fs.readFileSync(path.join(cwd, 'rigour.yml'), 'utf8'))?.gates ?? {};
        return gates.agent_team?.enabled === true || gates.checkpoint?.enabled === true;
    } catch {
        return false;
    }
}

export function getAdvertisedToolDefinitions(spec: string | undefined = process.env.RIGOUR_MCP_TOOLS, cwd = process.env.RIGOUR_CWD || process.cwd()) {
    const names = advertisedToolNames([spec, repoNeedsGovernance(cwd) ? 'governance' : ''].filter(Boolean).join(','));
    return TOOL_DEFINITIONS.filter(t => names.has(t.name));
}
