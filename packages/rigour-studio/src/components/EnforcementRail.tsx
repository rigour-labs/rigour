import React, { useEffect, useState } from 'react';
import {
    ShieldCheck,
    Users,
    Crosshair,
    Flag,
    ArrowRightLeft,
    Brain,
    RefreshCw,
    AlertTriangle,
    CheckCircle2,
    Circle,
} from 'lucide-react';

type StageStatus = 'idle' | 'pass' | 'warn' | 'block';

interface Stage {
    id: string;
    label: string;
    count: number;
    status: StageStatus;
    detail: string;
}

interface TimelineItem {
    type: string;
    timestamp: string | null;
    agentId: string | null;
    summary: string;
}

interface EnforcementPayload {
    stages: Stage[];
    timeline: TimelineItem[];
    derived?: boolean;
    agentCount?: number;
    sessionStatus?: string;
}

interface Props {
    onNavigate?: (tab: string) => void;
}

const STAGE_NAV: Record<string, string> = {
    register: 'agents',
    scope: 'cost',
    gates: 'gates',
    checkpoint: 'checkpoints',
    handoff: 'handoffs',
    memory: 'memory',
};

const STAGE_ICON: Record<string, React.ReactNode> = {
    register: <Users size={16} />,
    scope: <Crosshair size={16} />,
    gates: <ShieldCheck size={16} />,
    checkpoint: <Flag size={16} />,
    handoff: <ArrowRightLeft size={16} />,
    memory: <Brain size={16} />,
};

function statusIcon(status: StageStatus) {
    switch (status) {
        case 'pass':
            return <CheckCircle2 size={14} className="text-emerald" />;
        case 'warn':
            return <AlertTriangle size={14} className="text-amber" />;
        case 'block':
            return <AlertTriangle size={14} className="text-rose" />;
        default:
            return <Circle size={12} className="text-dim" />;
    }
}

export function EnforcementRail({ onNavigate }: Props) {
    const [data, setData] = useState<EnforcementPayload | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const load = async () => {
        setLoading(true);
        setError(null);
        try {
            const res = await fetch('/api/enforcement');
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            setData(await res.json());
        } catch (e: any) {
            setError(e.message || 'Failed to load enforcement');
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        load();
        const id = setInterval(load, 15000);
        return () => clearInterval(id);
    }, []);

    const stages = data?.stages || [];
    const conversions = stages.map((stage, idx) => {
        if (idx === 0) return null;
        const prev = stages[idx - 1].count;
        if (prev <= 0) return null;
        return Math.min(100, Math.round((stage.count / prev) * 100));
    });

    return (
        <div className="enforcement-view">
            <div className="panel-header enforcement-header">
                <div className="title">
                    <ShieldCheck size={18} />
                    <span>Enforcement Loop</span>
                </div>
                <div className="enforcement-header-meta">
                    {data?.derived && <span className="meta-chip">Derived from checkpoints</span>}
                    <span className="meta-chip">{data?.agentCount ?? 0} agents</span>
                    <button type="button" className="icon-btn" onClick={load} aria-label="Refresh enforcement">
                        <RefreshCw size={14} className={loading ? 'spinning' : ''} />
                    </button>
                </div>
            </div>

            <p className="enforcement-lead">
                How Rigour bounds agents: register scope, constrain context, run gates, compress checkpoints, verify
                handoffs, and store stable memory — for any MCP client.
            </p>

            {error && (
                <div className="cost-banner" role="alert">
                    <AlertTriangle size={18} className="text-rose" />
                    <div>
                        <strong>Could not load enforcement</strong>
                        <p>{error}</p>
                    </div>
                </div>
            )}

            {loading && !data && (
                <div className="enforcement-skeleton" aria-busy="true">
                    {Array.from({ length: 6 }).map((_, i) => (
                        <div key={i} className="skeleton-card" />
                    ))}
                </div>
            )}

            {stages.length > 0 && (
                <>
                    <ol className="enforcement-rail" aria-label="Enforcement stages">
                        {stages.map((stage, idx) => (
                            <li key={stage.id} className={`enforcement-stage status-${stage.status}`}>
                                {idx > 0 && (
                                    <div className="stage-connector" aria-hidden="true">
                                        {conversions[idx] != null && (
                                            <span className="conversion">{conversions[idx]}%</span>
                                        )}
                                    </div>
                                )}
                                <button
                                    type="button"
                                    className="stage-card glass-card"
                                    onClick={() => onNavigate?.(STAGE_NAV[stage.id] || 'overview')}
                                >
                                    <div className="stage-top">
                                        <span className="stage-icon">{STAGE_ICON[stage.id]}</span>
                                        {statusIcon(stage.status)}
                                    </div>
                                    <div className="stage-label">{stage.label}</div>
                                    <div className="stage-count">{stage.count}</div>
                                    <div className="stage-detail">{stage.detail}</div>
                                </button>
                            </li>
                        ))}
                    </ol>

                    <ul className="enforcement-list-fallback">
                        {stages.map((stage) => (
                            <li key={`list-${stage.id}`}>
                                <strong>{stage.label}</strong>: {stage.count} — {stage.detail} ({stage.status})
                            </li>
                        ))}
                    </ul>
                </>
            )}

            <div className="enforcement-timeline glass-card">
                <h3>Recent enforcement events</h3>
                {!data?.timeline?.length ? (
                    <p className="empty-inline">No gate/checkpoint/handoff events yet. Drive agents through MCP tools.</p>
                ) : (
                    <ul>
                        {data.timeline.slice(0, 12).map((item, idx) => (
                            <li key={`${item.type}-${idx}`}>
                                <span className={`tl-type type-${item.type}`}>{item.type}</span>
                                <span className="tl-summary">{item.summary}</span>
                                <span className="tl-meta mono">
                                    {item.agentId || '—'}
                                    {item.timestamp ? ` · ${new Date(item.timestamp).toLocaleTimeString()}` : ''}
                                </span>
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        </div>
    );
}
