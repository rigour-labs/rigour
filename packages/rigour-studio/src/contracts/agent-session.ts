export type AgentStatus = 'active' | 'idle' | 'completed' | 'unknown';
export type SessionStatus = 'active' | 'completed' | 'aborted' | 'inactive' | 'unknown';

export interface SafeAgentSession {
    sessionId: string;
    agents: Array<{ agentId: string; taskScope: string[]; registeredAt: string; lastCheckpoint?: string; status: AgentStatus }>;
    status: SessionStatus;
    createdAt: string;
    derived: boolean;
    warnings: string[];
}

function dateOrNow(value: unknown): string {
    if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return value;
    return new Date().toISOString();
}

export function normalizeAgentSession(input: unknown): SafeAgentSession {
    const value = input && typeof input === 'object' ? input as Record<string, unknown> : {};
    const warnings: string[] = Array.isArray(value.warnings)
        ? value.warnings.filter((warning): warning is string => typeof warning === 'string')
        : [];
    if (value.dataQuality === 'degraded' && warnings.length === 0) warnings.push('Session contains incomplete legacy data.');
    const rawAgents = Array.isArray(value.agents) ? value.agents : [];
    const agents = rawAgents.map((raw, index) => {
        const agent = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
        const agentId = typeof agent.agentId === 'string' && agent.agentId.trim() ? agent.agentId : `unknown-agent-${index + 1}`;
        const valid = new Set(['active', 'idle', 'completed']);
        const status = valid.has(String(agent.status)) ? agent.status as AgentStatus : 'unknown';
        if (status === 'unknown' || agentId.startsWith('unknown-agent')) warnings.push(`Agent ${index + 1} has incomplete legacy data.`);
        return {
            agentId,
            taskScope: Array.isArray(agent.taskScope) ? agent.taskScope.filter((scope): scope is string => typeof scope === 'string') : [],
            registeredAt: dateOrNow(agent.registeredAt),
            lastCheckpoint: typeof agent.lastCheckpoint === 'string' && !Number.isNaN(Date.parse(agent.lastCheckpoint)) ? agent.lastCheckpoint : undefined,
            status,
        };
    });
    const validSession = new Set(['active', 'completed', 'aborted', 'inactive']);
    const status = validSession.has(String(value.status)) ? value.status as SessionStatus : agents.length ? 'unknown' : 'inactive';
    if (agents.length && status === 'unknown') warnings.push('Session status was missing or invalid.');
    return {
        sessionId: typeof value.sessionId === 'string' && value.sessionId ? value.sessionId : 'unknown-session',
        agents,
        status,
        createdAt: dateOrNow(value.createdAt),
        derived: Boolean(value.derived),
        warnings,
    };
}
