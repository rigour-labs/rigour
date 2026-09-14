export type AgentStatus = 'active' | 'idle' | 'completed';
export type AgentSessionStatus = AgentStatus | 'aborted' | 'inactive';

export interface StudioAgent {
    agentId: string;
    taskScope: string[];
    registeredAt: string;
    lastCheckpoint?: string;
    status: AgentStatus;
}

export interface StudioAgentSession {
    schemaVersion: 1;
    sessionId: string;
    agents: StudioAgent[];
    status: AgentSessionStatus;
    createdAt: string;
    derived: boolean;
    dataQuality: 'valid' | 'degraded';
    warnings: string[];
}

export function resolveStudioVersion(cliVersion: unknown, mcpVersion: unknown): string {
    if (typeof cliVersion === 'string' && cliVersion.trim()) return cliVersion.trim();
    if (typeof mcpVersion === 'string' && mcpVersion.trim()) return mcpVersion.trim();
    return '0.0.0';
}

const AGENT_STATUSES = new Set<AgentStatus>(['active', 'idle', 'completed']);
const SESSION_STATUSES = new Set<AgentSessionStatus>([
    'active',
    'idle',
    'completed',
    'aborted',
    'inactive',
]);

function record(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function validDate(value: unknown, fallback: string): string {
    if (typeof value !== 'string' && typeof value !== 'number') return fallback;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

function inferSessionStatus(agents: StudioAgent[]): AgentSessionStatus {
    if (agents.length === 0) return 'inactive';
    if (agents.some((agent) => agent.status === 'active')) return 'active';
    if (agents.some((agent) => agent.status === 'idle')) return 'idle';
    return 'completed';
}

export function normalizeAgentSession(input: unknown, now = new Date().toISOString()): StudioAgentSession {
    const source = record(input);
    const warnings: string[] = [];
    const rawAgents = Array.isArray(source.agents) ? source.agents : [];

    if (!Array.isArray(source.agents) && source.agents !== undefined) {
        warnings.push('Ignored invalid agents collection.');
    }

    const agents = rawAgents.map((value, index): StudioAgent => {
        const raw = record(value);
        const agentId = typeof raw.agentId === 'string' && raw.agentId.trim()
            ? raw.agentId.trim()
            : `unknown-agent-${index + 1}`;
        if (agentId.startsWith('unknown-agent-')) warnings.push(`Agent ${index + 1} had no identifier.`);

        const taskScope = Array.isArray(raw.taskScope)
            ? raw.taskScope.filter((scope): scope is string => typeof scope === 'string' && scope.length > 0)
            : [];
        if (!Array.isArray(raw.taskScope) && raw.taskScope !== undefined) {
            warnings.push(`Agent ${agentId} had an invalid scope.`);
        }

        const status = typeof raw.status === 'string' && AGENT_STATUSES.has(raw.status as AgentStatus)
            ? raw.status as AgentStatus
            : 'idle';
        if (status === 'idle' && raw.status !== 'idle') warnings.push(`Agent ${agentId} had no valid status.`);

        const registeredAt = validDate(raw.registeredAt, now);
        const lastCheckpoint = raw.lastCheckpoint === undefined
            ? undefined
            : validDate(raw.lastCheckpoint, registeredAt);

        return { agentId, taskScope, registeredAt, lastCheckpoint, status };
    });

    const requestedStatus = typeof source.status === 'string'
        ? source.status as AgentSessionStatus
        : undefined;
    const status = requestedStatus && SESSION_STATUSES.has(requestedStatus)
        ? requestedStatus
        : inferSessionStatus(agents);
    if (requestedStatus !== status) warnings.push('Session status was inferred from agent activity.');

    return {
        schemaVersion: 1,
        sessionId: typeof source.sessionId === 'string' && source.sessionId.trim()
            ? source.sessionId
            : agents.length > 0 ? 'legacy-session' : 'inactive',
        agents,
        status,
        createdAt: validDate(source.createdAt, agents[0]?.registeredAt ?? now),
        derived: Boolean(source.derived),
        dataQuality: warnings.length > 0 ? 'degraded' : 'valid',
        warnings,
    };
}
