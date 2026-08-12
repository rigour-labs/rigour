import React from 'react';
import { Users, Circle, AlertTriangle, CheckCircle, Folder } from 'lucide-react';

interface Agent {
    agentId: string;
    taskScope: string[];
    registeredAt: string;
    lastCheckpoint?: string;
    status: 'active' | 'idle' | 'completed';
}

interface AgentSession {
    sessionId: string;
    agents: Agent[];
    status: 'active' | 'completed' | 'aborted' | 'inactive';
    createdAt: string;
    derived?: boolean;
}

interface Props {
    session?: AgentSession | null;
}

function scopesOverlap(a: string, b: string): boolean {
    if (!a || !b) return false;
    if (a === b) return true;

    if (a.startsWith('task:') || b.startsWith('task:')) {
        return a === b;
    }

    const pathOverlap = (left: string, right: string) =>
        left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);

    return pathOverlap(a, b);
}

function humanLabel(agentId: string): string {
    if (agentId.startsWith('CTP-')) return agentId.replace(/-task$/, '');
    if (agentId.length > 28) return `${agentId.slice(0, 12)}…${agentId.slice(-8)}`;
    return agentId;
}

export function AgentTeams({ session }: Props) {
    if (!session || session.agents.length === 0) {
        return (
            <div className="empty-state glass-card">
                <Users size={48} />
                <h3>No Active Agent Team</h3>
                <p>
                    Register agents with <code>rigour_agent_register</code>, or Studio will derive recent agents from
                    checkpoint metrics in the Brain DB.
                </p>
                <div className="hint-box">
                    <span>Register agents with <code>rigour_agent_register</code>. Claimed globs are <strong>enforced</strong> on mediated writes (hooks / firewall)—not advisory.</span>
                </div>
            </div>
        );
    }

    const isHistorical = Boolean(session.derived) || session.status === 'completed';

    const getStatusIcon = (status: string) => {
        switch (status) {
            case 'active':
                return <Circle size={10} fill="#34d399" stroke="#34d399" />;
            case 'idle':
                return <Circle size={10} fill="#fbbf24" stroke="#fbbf24" />;
            case 'completed':
                return <CheckCircle size={14} color="#34d399" />;
            default:
                return <Circle size={10} />;
        }
    };

    const hasConflicts = (agent: Agent, allAgents: Agent[]) => {
        // Historical / derived sessions are not live concurrent teams.
        if (isHistorical) return false;
        if (agent.status === 'completed') return false;

        const livePeers = allAgents.filter(
            (other) => other.agentId !== agent.agentId && other.status !== 'completed',
        );

        return livePeers.some((other) =>
            agent.taskScope.some((scope) => other.taskScope.some((s) => scopesOverlap(scope, s))),
        );
    };

    return (
        <div className="agent-teams">
            <div className="panel-header">
                <div className="title">
                    <Users size={18} />
                    <span>Agent Team Session</span>
                </div>
                <div className={`session-status ${session.status}`}>{session.status.toUpperCase()}</div>
            </div>

            <div className="session-info">
                <span className="session-id">{session.sessionId}</span>
                <span className="agent-count">{session.agents.length} agents</span>
                {session.derived && <span className="meta-chip">Historical (derived)</span>}
            </div>

            <div className="agents-grid">
                {session.agents.map((agent) => {
                    const conflict = hasConflicts(agent, session.agents);
                    return (
                        <div
                            key={agent.agentId}
                            className={`agent-card glass-card ${agent.status} ${conflict ? 'has-conflict' : ''}`}
                        >
                            <div className="agent-header">
                                <div className="agent-id">
                                    {getStatusIcon(agent.status)}
                                    <span title={agent.agentId}>{humanLabel(agent.agentId)}</span>
                                </div>
                                {conflict && (
                                    <div className="conflict-badge">
                                        <AlertTriangle size={12} />
                                        <span>Scope Conflict</span>
                                    </div>
                                )}
                            </div>

                            <div className="task-scope">
                                <h4>Enforced scope</h4>
                                <ul>
                                    {agent.taskScope.map((scope, idx) => (
                                        <li key={idx}>
                                            <Folder size={12} />
                                            <code>{scope}</code>
                                        </li>
                                    ))}
                                </ul>
                            </div>

                            <div className="agent-meta">
                                <span>Registered: {new Date(agent.registeredAt).toLocaleTimeString()}</span>
                                {agent.lastCheckpoint && (
                                    <span>Last checkpoint: {new Date(agent.lastCheckpoint).toLocaleTimeString()}</span>
                                )}
                            </div>
                            <div className="mono dim agent-raw-id">{agent.agentId}</div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
