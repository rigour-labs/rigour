/** Agent names as Rigour recorded them. The brief's `agent` can name the way it was asked for (the CLI, MCP) or a person: not an agent. */
const NOT_AGENTS = new Set(['cli', 'mcp', 'person']);

/** The recorded agent, or null when none was recorded or the value names a way of asking rather than an agent. */
export function recordedAgent(agent: unknown): string | null {
    return typeof agent === 'string' && agent.trim() && !NOT_AGENTS.has(agent.trim().toLowerCase()) ? agent : null;
}
