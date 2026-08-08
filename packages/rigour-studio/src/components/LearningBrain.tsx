import React, { useEffect, useState } from 'react';
import { Brain, RefreshCw, Database, ScanSearch, Sparkles, AlertCircle } from 'lucide-react';

interface LearningPayload {
    memoryCount?: number;
    memorySources?: string[];
    patternCount?: number;
    patternFiles?: number;
    checkpointCount?: number;
    eventCount?: number;
    context?: { retrievals?: number; cacheHitRate?: number };
    cache?: {
        exactCacheHits?: number;
        semanticCacheHits?: number;
        partialCacheHits?: number;
        cacheMisses?: number;
        hitRate?: number;
    };
}

interface Props {
    onNavigate?: (tab: string) => void;
}

export function LearningBrain({ onNavigate }: Props) {
    const [data, setData] = useState<LearningPayload | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const load = async () => {
        setLoading(true);
        setError(null);
        try {
            const res = await fetch('/api/overview');
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            setData(await res.json());
        } catch (e: any) {
            setError(e.message || 'Failed to load learning signals');
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        load();
    }, []);

    const cache = data?.cache;
    const hits =
        (cache?.exactCacheHits ?? 0) +
        (cache?.semanticCacheHits ?? 0) +
        (cache?.partialCacheHits ?? 0);
    const misses = cache?.cacheMisses ?? 0;
    const hitPct = Math.round((cache?.hitRate ?? 0) * 100);

    return (
        <div className="learning-brain">
            <div className="panel-header">
                <div className="title">
                    <Brain size={18} />
                    <span>How Rigour Learns</span>
                </div>
                <button type="button" className="icon-btn" onClick={load} aria-label="Refresh learning">
                    <RefreshCw size={14} className={loading ? 'spinning' : ''} />
                </button>
            </div>

            <p className="enforcement-lead">
                Scans feed the pattern index; agents write stable memory; context scope + cache reuse cut reread cost;
                checkpoints compress handoffs. This is governance learning — not model fine-tuning.
            </p>

            {error && (
                <div className="cost-banner" role="alert">
                    <AlertCircle size={18} className="text-rose" />
                    <div>
                        <strong>Could not load learning signals</strong>
                        <p>{error}</p>
                    </div>
                </div>
            )}

            <div className="learning-grid">
                <article className="glass-card learning-card">
                    <header>
                        <ScanSearch size={16} className="text-cyan" />
                        <h3>Pattern index (from scans)</h3>
                    </header>
                    <div className="learning-kpi">{data?.patternCount ?? 0}</div>
                    <p className="dim">
                        {data?.patternFiles ?? 0} files indexed. Refresh with <code>rigour index</code> after large
                        refactors.
                    </p>
                    <button type="button" className="overview-link" onClick={() => onNavigate?.('patterns')}>
                        Open Pattern Index
                    </button>
                </article>

                <article className="glass-card learning-card">
                    <header>
                        <Sparkles size={16} className="text-amber" />
                        <h3>Stable memory</h3>
                    </header>
                    <div className="learning-kpi">{data?.memoryCount ?? 0}</div>
                    <p className="dim">
                        Deliberate facts via <code>rigour_remember</code>
                        {data?.memorySources?.length ? ` · ${data.memorySources.join(' + ')}` : ''}. Not a scan log.
                    </p>
                    <button type="button" className="overview-link" onClick={() => onNavigate?.('memory')}>
                        Open Memory Bank
                    </button>
                </article>

                <article className="glass-card learning-card">
                    <header>
                        <Database size={16} className="text-emerald" />
                        <h3>Context cache power</h3>
                    </header>
                    <div className="learning-kpi text-cyan">{hitPct}%</div>
                    <p className="dim">
                        {hits} hits ({cache?.exactCacheHits ?? 0} exact · {cache?.semanticCacheHits ?? 0} semantic ·{' '}
                        {cache?.partialCacheHits ?? 0} partial) / {misses} misses · {data?.context?.retrievals ?? 0}{' '}
                        retrievals
                    </p>
                    <button type="button" className="overview-link" onClick={() => onNavigate?.('cost')}>
                        Open Cost &amp; Context
                    </button>
                </article>

                <article className="glass-card learning-card">
                    <header>
                        <Brain size={16} className="text-purple" />
                        <h3>Governance trail</h3>
                    </header>
                    <div className="learning-kpi">{data?.checkpointCount ?? 0}</div>
                    <p className="dim">
                        Checkpoints compressed · {(data?.eventCount ?? 0).toLocaleString()} project events in{' '}
                        <code>.rigour/events.jsonl</code> / Brain DB.
                    </p>
                    <button type="button" className="overview-link" onClick={() => onNavigate?.('enforcement')}>
                        Open Enforcement Loop
                    </button>
                </article>
            </div>
        </div>
    );
}
