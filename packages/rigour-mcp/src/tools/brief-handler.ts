/**
 * rigour_brief: the team's briefing for a task, for any agent that speaks MCP (Claude Code gets it from a prompt hook).
 * Read-only apart from the task thread's record of what was briefed; nothing when the team switched briefings off.
 */
import { briefFile, briefingText, briefTask, fileBriefingText, type Config } from '@rigour-labs/core';

export function handleBrief(cwd: string, config: Config, args: { goal?: string; files?: unknown; agent?: string }): { content: Array<{ type: 'text'; text: string }> } {
    if (config.brief?.enabled === false || /^(0|false|off|no)$/i.test(process.env.RIGOUR_BRIEF?.trim() ?? '')) {
        return { content: [{ type: 'text', text: 'Briefings are switched off in this repository (brief.enabled: false, or RIGOUR_BRIEF=0).' }] };
    }
    const files = Array.isArray(args.files) ? args.files.filter((f): f is string => typeof f === 'string' && !!f.trim()) : undefined;
    const lessons = config.gates.deep?.review_lessons;
    const agent = args.agent ?? 'mcp';
    // Files and no goal: the agent is about to edit them; the team's word on each, like the edit hook (at most three each, ten in all).
    if (!args.goal?.trim() && files?.length) {
        const texts = files.slice(0, 10).map(file => fileBriefingText(briefFile(cwd, file, { agent, ...(lessons ? { lessons } : {}) }))).filter(Boolean);
        return { content: [{ type: 'text', text: texts.join('\n\n') || `Nothing to brief for ${files.join(', ')}: no rule or lesson of this repository names them yet.` }] };
    }
    const briefing = briefTask(cwd, { goal: args.goal, ...(files?.length ? { files } : {}), limit: config.brief?.max_items ?? 10, agent, ...(lessons ? { lessons } : {}) });
    const text = briefingText(briefing) || `Nothing to brief: no rule or verified lesson of this repository applies to ${briefing.files.length ? briefing.files.join(', ') : 'this task'} yet.`;
    return { content: [{ type: 'text', text }] };
}
