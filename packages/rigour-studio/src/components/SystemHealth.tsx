import React from 'react';
import { Activity, Brain, Database, Network, RefreshCw, Server, Workflow } from 'lucide-react';

export interface HealthData {
    index?: { status?: string; patterns?: number; files?: number; updatedAt?: string };
    graph?: { status?: string; nodes?: number; edges?: number };
    semantic?: { status?: string; provider?: 'local' | 'pgvector'; message?: string };
    caches?: { status?: string; layers?: Record<string, number> };
    learning?: { status?: string; total?: number; observations?: number };
    storage?: { mode?: string; connectivity?: string; queuedChanges?: number; message?: string };
    error?: string;
}

interface Props { data: HealthData | null; loading: boolean; stale: boolean; onRetry: () => void; }

function HealthItem({ icon: Icon, label, status, detail }: { icon: React.ElementType; label: string; status: string; detail: string }) {
    const state = ['ready', 'active', 'online', 'local'].includes(status) ? 'ready' : ['warming', 'idle', 'missing'].includes(status) ? 'warming' : 'degraded';
    return (
        <div className={`health-item ${state}`}>
            <Icon size={15} aria-hidden="true" />
            <span><strong>{label}</strong><small>{detail}</small></span>
            <span className="health-state">{status}</span>
        </div>
    );
}

export function SystemHealth({ data, loading, stale, onRetry }: Props) {
    if (loading && !data) return <div className="system-health loading"><Activity size={16} className="spinning" /> Checking system health…</div>;
    if (!data || data.error) return (
        <div className="system-health unavailable" role="alert">
            <Server size={16} /> Health unavailable
            <button type="button" onClick={onRetry}><RefreshCw size={14} /> Retry</button>
        </div>
    );
    const layerCount = Object.values(data.caches?.layers ?? {}).filter((count) => count > 0).length;
    return (
        <section className={`system-health ${stale ? 'stale' : ''}`} aria-label="System health">
            <HealthItem icon={Database} label="Index" status={data.index?.status ?? 'missing'} detail={`${data.index?.patterns ?? 0} patterns · ${data.index?.files ?? 0} files`} />
            <HealthItem icon={Workflow} label="Graph" status={data.graph?.status ?? 'missing'} detail={`${data.graph?.nodes ?? 0} nodes · ${data.graph?.edges ?? 0} edges`} />
            <HealthItem icon={Brain} label="Semantic" status={data.semantic?.status ?? 'disabled'} detail={data.semantic?.message ?? 'Background enrichment'} />
            <HealthItem icon={Network} label="Cache" status={data.caches?.status ?? 'warming'} detail={`${layerCount}/4 layers populated`} />
            <HealthItem icon={Activity} label="Learning" status={data.learning?.status ?? 'idle'} detail={`${data.learning?.observations ?? 0} interactions · ${data.learning?.total ?? 0} lessons`} />
            <HealthItem icon={Server} label="Storage" status={data.storage?.connectivity ?? 'local'} detail={data.storage?.connectivity === 'offline' ? `${data.storage?.queuedChanges ?? 0} queued` : data.storage?.mode ?? 'local'} />
        </section>
    );
}
