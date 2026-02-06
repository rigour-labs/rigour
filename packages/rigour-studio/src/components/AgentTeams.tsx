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
    status: 'active' | 'completed' | 'aborted';
    createdAt: string;
}

interface Props {
    session?: AgentSession | null;
}

export function AgentTeams({ session }: Props) {
    if (!session || session.agents.length === 0) {
        return (
            <div className="empty-state">
                <Users size={48} />
                <h3>No Active Agent Team</h3>
                <p>When multiple agents register via <code>rigour_agent_register</code>, they'll appear here.</p>
                <div className="hint-box">
                    <span>Supported Models:</span>
                    <div className="model-badges">
                        <span className="badge opus">Opus 4.6</span>
                        <span className="badge gpt">GPT-5.3</span>
                    </div>
                </div>
            </div>
        );
    }

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
        return allAgents.some(other => {
            if (other.agentId === agent.agentId) return false;
            return agent.taskScope.some(scope =>
                other.taskScope.some(s => s === scope || scope.startsWith(s) || s.startsWith(scope))
            );
        });
    };

    return (
        <div className="agent-teams">
            <div className="panel-header">
                <div className="title">
                    <Users size={18} />
                    <span>Agent Team Session</span>
                </div>
                <div className={`session-status ${session.status}`}>
                    {session.status.toUpperCase()}
                </div>
            </div>

            <div className="session-info">
                <span className="session-id">{session.sessionId}</span>
                <span className="agent-count">{session.agents.length} agents</span>
            </div>

            <div className="agents-grid">
                {session.agents.map((agent) => (
                    <div
                        key={agent.agentId}
                        className={`agent-card ${agent.status} ${hasConflicts(agent, session.agents) ? 'has-conflict' : ''}`}
                    >
                        <div className="agent-header">
                            <div className="agent-id">
                                {getStatusIcon(agent.status)}
                                <span>{agent.agentId}</span>
                            </div>
                            {hasConflicts(agent, session.agents) && (
                                <div className="conflict-badge">
                                    <AlertTriangle size={12} />
                                    <span>Scope Conflict</span>
                                </div>
                            )}
                        </div>

                        <div className="task-scope">
                            <h4>Task Scope</h4>
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
                    </div>
                ))}
            </div>
        </div>
    );
}
