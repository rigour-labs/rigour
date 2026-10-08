/**
 * rigour_brief: the team's briefing for a task, for any agent that speaks MCP (Claude Code gets it from a prompt hook).
 * Read-only apart from the task thread's record of what was briefed; nothing when the team switched briefings off.
 */
import { briefingText, briefTask, type Config } from '@rigour-labs/core';

export function handleBrief(cwd: string, config: Config, args: { goal?: string; files?: unknown; agent?: string }): { content: Array<{ type: 'text'; text: string }> } {
    if (config.brief?.enabled === false || /^(0|false|off|no)$/i.test(process.env.RIGOUR_BRIEF?.trim() ?? '')) {
        return { content: [{ type: 'text', text: 'Briefings are switched off in this repository (brief.enabled: false, or RIGOUR_BRIEF=0).' }] };
    }
    const files = Array.isArray(args.files) ? args.files.filter((f): f is string => typeof f === 'string' && !!f.trim()) : undefined;
    const lessons = config.gates.deep?.review_lessons;
    const briefing = briefTask(cwd, { goal: args.goal, ...(files?.length ? { files } : {}), limit: config.brief?.max_items ?? 10, agent: args.agent ?? 'mcp', ...(lessons ? { lessons } : {}) });
    const text = briefingText(briefing) || `Nothing to brief: no rule or verified lesson of this repository applies to ${briefing.files.length ? briefing.files.join(', ') : 'this task'} yet.`;
    return { content: [{ type: 'text', text }] };
}
