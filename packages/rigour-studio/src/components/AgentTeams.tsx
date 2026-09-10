import React from 'react';
import { Users, Circle, AlertTriangle, CheckCircle, Folder, Lightbulb, Gauge, Database } from 'lucide-react';
import { normalizeAgentSession, type SafeAgentSession } from '../contracts/agent-session';

interface Props { session?: unknown; }

interface HistoricalRun {
    id: string;
    agentId: string;
    taskId?: string;
    startedAt: string;
    endedAt: string;
    status: string;
    eventCount: number;
    files: string[];
    tools: string[];
    impact?: {
        guidanceCount: number;
        knowledgeItems: number;
        candidateTokens: number;
        returnedTokens: number;
        avoidedTokens: number;
        candidateFiles: number;
        returnedFiles: number;
        excludedFiles: number;
        cacheHits: number;
        recommendations: string[];
    };
}

interface HistoricalEvent {
    id: string;
    timestamp: string;
    agentId: string;
    type: string;
    tool?: string;
    outcome: string;
    summary: string;
    guidance?: { recommendation?: string };
}

function metric(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function mergeImpact(left?: HistoricalRun['impact'], right?: HistoricalRun['impact']): HistoricalRun['impact'] | undefined {
    if (!left) return right;
    if (!right) return left;
    return {
        guidanceCount: metric(left.guidanceCount) + metric(right.guidanceCount),
        knowledgeItems: metric(left.knowledgeItems) + metric(right.knowledgeItems),
        candidateTokens: metric(left.candidateTokens) + metric(right.candidateTokens),
        returnedTokens: metric(left.returnedTokens) + metric(right.returnedTokens),
        avoidedTokens: metric(left.avoidedTokens) + metric(right.avoidedTokens),
        candidateFiles: metric(left.candidateFiles) + metric(right.candidateFiles),
        returnedFiles: metric(left.returnedFiles) + metric(right.returnedFiles),
        excludedFiles: metric(left.excludedFiles) + metric(right.excludedFiles),
        cacheHits: metric(left.cacheHits) + metric(right.cacheHits),
        recommendations: [...new Set([...(left.recommendations ?? []), ...(right.recommendations ?? [])])],
    };
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
    const safeSession = normalizeAgentSession(session);
    const [view, setView] = React.useState<'live' | 'runs' | 'timeline'>('live');
    const [history, setHistory] = React.useState<{ runs: HistoricalRun[]; events: HistoricalEvent[]; hasMore: boolean; nextBefore?: number }>({ runs: [], events: [], hasMore: false });
    const [historyError, setHistoryError] = React.useState('');
    const [historyLoading, setHistoryLoading] = React.useState(true);

    const loadHistory = React.useCallback(async (before?: number) => {
        if (!before) setHistoryLoading(true);
        setHistoryError('');
        try {
            const response = await fetch(`/api/agent-history?limit=500${before ? `&before=${before}` : ''}`);
            const payload = await response.json();
            if (!response.ok || payload.error) throw new Error(payload.error || `HTTP ${response.status}`);
            setHistory(previous => {
                const pageRuns: HistoricalRun[] = Array.isArray(payload.runs) ? payload.runs : [];
                if (!before) return { runs: pageRuns, events: Array.isArray(payload.events) ? payload.events : [], hasMore: Boolean(payload.hasMore), nextBefore: payload.nextBefore };
                const mergedRuns = new Map(previous.runs.map(run => [run.id, run]));
                for (const run of pageRuns) {
                    const current = mergedRuns.get(run.id);
                    mergedRuns.set(run.id, current ? {
                        ...current,
                        startedAt: Date.parse(run.startedAt) < Date.parse(current.startedAt) ? run.startedAt : current.startedAt,
                        eventCount: current.eventCount + run.eventCount,
                        files: [...new Set([...current.files, ...run.files])],
                        tools: [...new Set([...current.tools, ...run.tools])],
                        impact: mergeImpact(current.impact, run.impact),
                    } : run);
                }
                return {
                    runs: [...mergedRuns.values()].sort((a, b) => Date.parse(b.endedAt) - Date.parse(a.endedAt)),
                    events: [...previous.events, ...(Array.isArray(payload.events) ? payload.events : [])],
                    hasMore: Boolean(payload.hasMore),
                    nextBefore: payload.nextBefore,
                };
            });
        } catch (error) {
            setHistoryError(error instanceof Error ? error.message : String(error));
        } finally {
            setHistoryLoading(false);
        }
    }, []);

    React.useEffect(() => { void loadHistory(); }, [loadHistory]);

    const isHistorical = safeSession.derived || safeSession.status === 'completed';

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

    const hasConflicts = (agent: SafeAgentSession['agents'][number], allAgents: SafeAgentSession['agents']) => {
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
                <div className={`session-status ${safeSession.status}`}>{safeSession.status.toUpperCase()}</div>
            </div>

            <div className="agent-view-tabs" role="tablist" aria-label="Agent activity views">
                {(['live', 'runs', 'timeline'] as const).map(item => (
                    <button key={item} type="button" role="tab" aria-selected={view === item} className={view === item ? 'active' : ''} onClick={() => setView(item)}>
                        {item === 'live' ? 'Live team' : item === 'runs' ? `Run history (${history.runs.length})` : `Event timeline (${history.events.length})`}
                    </button>
                ))}
                {history.hasMore && <button type="button" className="history-load" onClick={() => void loadHistory(history.nextBefore)} disabled={!history.nextBefore}>Load older</button>}
            </div>

            {view !== 'live' && historyLoading && <div className="agent-history-state">Loading retained agent history…</div>}
            {view !== 'live' && historyError && <div className="agent-history-state error" role="alert">History unavailable: {historyError}<button type="button" onClick={() => void loadHistory()}>Retry</button></div>}

            {view === 'runs' && !historyLoading && !historyError && (
                history.runs.length ? <div className="agent-run-list">
                    {history.runs.map(run => <article key={run.id} className="agent-run-row glass-card">
                        <div><strong>{humanLabel(run.agentId)}</strong><span>{run.taskId || run.id}</span></div>
                        <span className={`run-outcome ${run.status}`}>{run.status}</span>
                        <div><strong>{run.eventCount}</strong><span>events</span></div>
                        <div><strong>{run.files.length}</strong><span>files</span></div>
                        <div className="run-time"><strong>{new Date(run.endedAt).toLocaleString()}</strong><span>{run.tools.slice(0, 3).join(', ') || 'No tool recorded'}</span></div>
                        {metric(run.impact?.guidanceCount) > 0 && <details className="impact-receipt">
                            <summary><Lightbulb size={14} /><strong>Rigour impact</strong><span>{metric(run.impact?.guidanceCount)} advice · {metric(run.impact?.avoidedTokens).toLocaleString()} tokens avoided</span></summary>
                            <div className="impact-receipt-body">
                                <p>{run.impact?.recommendations?.[0] || 'Rigour supplied evidence-backed guidance during this run.'}</p>
                                <dl>
                                    <div><dt><Database size={13} />Knowledge reused</dt><dd>{metric(run.impact?.knowledgeItems)} items</dd></div>
                                    <div><dt><Folder size={13} />Context scope</dt><dd>{metric(run.impact?.returnedFiles)} selected · {metric(run.impact?.excludedFiles)} excluded</dd></div>
                                    <div><dt><Gauge size={13} />Token impact</dt><dd>{metric(run.impact?.avoidedTokens).toLocaleString()} avoided · measured estimate</dd></div>
                                    <div><dt><CheckCircle size={13} />Cache reuse</dt><dd>{metric(run.impact?.cacheHits)} hits</dd></div>
                                </dl>
                                {(run.impact?.recommendations?.length ?? 0) > 1 && <ul>{run.impact?.recommendations.slice(1, 4).map(item => <li key={item}>{item}</li>)}</ul>}
                            </div>
                        </details>}
                    </article>)}
                </div> : <div className="empty-state glass-card"><Users size={40} /><h3>No retained runs yet</h3><p>Runs appear as agents emit tool, checkpoint, verification and handoff events.</p></div>
            )}

            {view === 'timeline' && !historyLoading && !historyError && (
                history.events.length ? <ol className="agent-event-timeline">
                    {history.events.map(event => <li key={`${event.id}-${event.timestamp}`}>
                        <span className={`timeline-marker ${event.outcome}`} />
                        <time>{new Date(event.timestamp).toLocaleString()}</time>
                        <div><strong>{event.tool || event.type}{event.guidance?.recommendation ? ' · Advice issued' : ''}</strong><span>{humanLabel(event.agentId)} · {event.guidance?.recommendation || event.summary}</span></div>
                        <span className={`run-outcome ${event.outcome}`}>{event.outcome}</span>
                    </li>)}
                </ol> : <div className="empty-state glass-card"><Users size={40} /><h3>No historical events</h3><p>Rigour will retain normal agent activity without requiring deep analysis.</p></div>
            )}

            {view === 'live' && safeSession.agents.length === 0 && (
                <div className="empty-state glass-card">
                    <Users size={48} />
                    <h3>No Active Agent Team</h3>
                    <p>There is no live team now. Previous activity remains available in Run history and Event timeline.</p>
                    <div className="hint-box"><span>Register agents with <code>rigour_agent_register</code>. Claimed scopes are enforced per bound agent.</span></div>
                </div>
            )}

            {view === 'live' && safeSession.warnings.length > 0 && (
                <div className="overview-banner warn" role="alert">
                    <AlertTriangle size={18} />
                    <div><strong>Some team data is incomplete</strong><p>{safeSession.warnings.join(' ')}</p></div>
                </div>
            )}

            {view === 'live' && safeSession.agents.length > 0 && <><div className="session-info">
                <span className="session-id">{safeSession.sessionId}</span>
                <span className="agent-count">{safeSession.agents.length} agents</span>
                {safeSession.derived && <span className="meta-chip">Historical (derived)</span>}
            </div>

            <div className="agents-grid">
                {safeSession.agents.map((agent) => {
                    const conflict = hasConflicts(agent, safeSession.agents);
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
            </div></>}
        </div>
    );
}
