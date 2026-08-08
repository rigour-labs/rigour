import React, { useEffect, useState } from 'react';
import {
    LayoutDashboard,
    RefreshCw,
    Coins,
    Database,
    Flag,
    Brain,
    Activity,
    AlertCircle,
    ArrowRight,
    Folder,
} from 'lucide-react';

interface OverviewData {
    context?: {
        retrievals?: number;
        candidateTokens?: number;
        returnedTokens?: number;
        potentialAvoidedTokens?: number;
        cacheHitRate?: number;
        checkpointReplayAvoided?: number;
    };
    cost?: {
        actual?: { inputTokens?: number; costUsd?: number; source?: string };
        estimated?: { potentialContextAvoided?: number; estimatedCostAvoidedUsd?: number };
    };
    cache?: {
        hitRate?: number;
        exactCacheHits?: number;
        semanticCacheHits?: number;
        cacheMisses?: number;
        tokensServedFromCache?: number;
    };
    checkpointSummary?: {
        checkpointCount?: number;
        compressionRatio?: number;
        replayTokensAvoided?: number;
        checkpointTokens?: number;
        rawStateTokens?: number;
    };
    checkpointCount?: number;
    memoryCount?: number;
    memorySources?: string[];
    patternCount?: number;
    patternFiles?: number;
    eventCount?: number;
    projectPath?: string;
    brainDb?: string;
    error?: string;
}

interface Props {
    onNavigate: (tab: string) => void;
}

function formatTokens(num?: number): string {
    const n = num ?? 0;
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return String(n);
}

export function Overview({ onNavigate }: Props) {
    const [data, setData] = useState<OverviewData | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const load = async () => {
        setLoading(true);
        setError(null);
        try {
            const res = await fetch('/api/overview');
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const json = await res.json();
            if (json.error) throw new Error(json.error);
            setData(json);
        } catch (e: any) {
            setError(e.message || 'Failed to load overview');
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        load();
    }, []);

    const avoided = data?.context?.potentialAvoidedTokens ?? 0;
    const replayAvoided = data?.context?.checkpointReplayAvoided ?? 0;
    const cachePct = Math.round((data?.cache?.hitRate ?? 0) * 100);
    const actualCost = data?.cost?.actual?.costUsd ?? 0;
    const estAvoidedCost = data?.cost?.estimated?.estimatedCostAvoidedUsd ?? 0;
    const hasSignal =
        (data?.context?.retrievals ?? 0) > 0 ||
        (data?.checkpointCount ?? 0) > 0 ||
        (data?.memoryCount ?? 0) > 0 ||
        (data?.cost?.actual?.inputTokens ?? 0) > 0;

    return (
        <div className="overview-view">
            <div className="overview-header">
                <div>
                    <h2>
                        <LayoutDashboard size={22} />
                        Governance Overview
                    </h2>
                    <p className="overview-dek">
                        Local governance signal — measured context avoided, cache hits, checkpoints. Spend is observed;
                        avoided $ is always an estimate.
                    </p>
                </div>
                <button className="refresh-btn" onClick={load} disabled={loading} type="button">
                    <RefreshCw size={16} className={loading ? 'spinning' : ''} />
                    Refresh
                </button>
            </div>

            {error && (
                <div className="overview-banner warn">
                    <AlertCircle size={18} />
                    <div>
                        <strong>Could not load telemetry</strong>
                        <p>{error}. Confirm Studio is serving <code>/api/overview</code> on the same port as the UI.</p>
                    </div>
                </div>
            )}

            {!error && !loading && !hasSignal && (
                <div className="overview-banner warn">
                    <AlertCircle size={18} />
                    <div>
                        <strong>No agent telemetry yet</strong>
                        <p>
                            Run agents with Rigour MCP (<code>rigour_recall</code>, <code>rigour_context_scope</code>,{' '}
                            <code>rigour_checkpoint</code>) or import observed usage under Cost &amp; Context.
                        </p>
                    </div>
                </div>
            )}

            <div className="overview-kpi-grid">
                <button type="button" className="overview-kpi" onClick={() => onNavigate('cost')}>
                    <span className="kpi-label">Context avoided</span>
                    <span className="kpi-value amber">{formatTokens(avoided + replayAvoided)}</span>
                    <span className="kpi-meta">retrieval + checkpoint replay</span>
                </button>
                <button type="button" className="overview-kpi" onClick={() => onNavigate('cost')}>
                    <span className="kpi-label">Cache hit rate</span>
                    <span className="kpi-value cyan">{cachePct}%</span>
                    <span className="kpi-meta">
                        {data?.cache?.exactCacheHits ?? 0} exact · {data?.cache?.semanticCacheHits ?? 0} semantic
                    </span>
                </button>
                <button type="button" className="overview-kpi" onClick={() => onNavigate('checkpoints')}>
                    <span className="kpi-label">Checkpoints</span>
                    <span className="kpi-value">{data?.checkpointCount ?? 0}</span>
                    <span className="kpi-meta">
                        {data?.checkpointSummary?.compressionRatio
                            ? `${data.checkpointSummary.compressionRatio}× avg compression`
                            : 'from Brain DB'}
                    </span>
                </button>
                <button type="button" className="overview-kpi" onClick={() => onNavigate('cost')}>
                    <span className="kpi-label">Observed spend / est. avoided</span>
                    <span className="kpi-value">
                        ${actualCost.toFixed(2)}
                        <span className="kpi-split"> / ${estAvoidedCost.toFixed(2)}</span>
                    </span>
                    <span className="kpi-meta">
                        {(data?.cost?.actual?.source || 'no usage source') + ' · avoided $ is estimated'}
                    </span>
                </button>
            </div>

            <div className="overview-panels">
                <section className="overview-card">
                    <header>
                        <Activity size={16} />
                        <h3>Live signal</h3>
                    </header>
                    <dl className="overview-dl">
                        <div>
                            <dt>Context retrievals</dt>
                            <dd>{data?.context?.retrievals ?? 0}</dd>
                        </div>
                        <div>
                            <dt>Candidate → returned</dt>
                            <dd>
                                {formatTokens(data?.context?.candidateTokens)} →{' '}
                                {formatTokens(data?.context?.returnedTokens)}
                            </dd>
                        </div>
                        <div>
                            <dt>Project events</dt>
                            <dd>{(data?.eventCount ?? 0).toLocaleString()}</dd>
                        </div>
                        <div>
                            <dt>Tokens from cache</dt>
                            <dd>{formatTokens(data?.cache?.tokensServedFromCache)}</dd>
                        </div>
                    </dl>
                    <button type="button" className="overview-link" onClick={() => onNavigate('audit')}>
                        Open audit log <ArrowRight size={14} />
                    </button>
                </section>

                <section className="overview-card">
                    <header>
                        <Brain size={16} />
                        <h3>How Rigour learns</h3>
                    </header>
                    <p className="overview-learn-note">
                        Memory = stable facts agents wrote via <code>rigour_remember</code>. Patterns = indexed symbols
                        from scans (not a full training log). Enforcement + checkpoints show live governance learning.
                    </p>
                    <dl className="overview-dl">
                        <div>
                            <dt>Memories</dt>
                            <dd>
                                {data?.memoryCount ?? 0}
                                {data?.memorySources?.length
                                    ? ` (${data.memorySources.join(' + ')})`
                                    : ''}
                            </dd>
                        </div>
                        <div>
                            <dt>Pattern index</dt>
                            <dd>
                                {data?.patternCount ?? 0} patterns / {data?.patternFiles ?? 0} files
                            </dd>
                        </div>
                    </dl>
                    <div className="overview-actions">
                        <button type="button" className="overview-link" onClick={() => onNavigate('memory')}>
                            Memory bank <ArrowRight size={14} />
                        </button>
                        <button type="button" className="overview-link" onClick={() => onNavigate('patterns')}>
                            Patterns <ArrowRight size={14} />
                        </button>
                    </div>
                </section>

                <section className="overview-card">
                    <header>
                        <Flag size={16} />
                        <h3>Checkpoint compression</h3>
                    </header>
                    <dl className="overview-dl">
                        <div>
                            <dt>Raw session state</dt>
                            <dd>{formatTokens(data?.checkpointSummary?.rawStateTokens)}</dd>
                        </div>
                        <div>
                            <dt>Checkpoint packets</dt>
                            <dd>{formatTokens(data?.checkpointSummary?.checkpointTokens)}</dd>
                        </div>
                        <div>
                            <dt>Replay avoided</dt>
                            <dd className="amber">{formatTokens(data?.checkpointSummary?.replayTokensAvoided)}</dd>
                        </div>
                    </dl>
                    <button type="button" className="overview-link" onClick={() => onNavigate('checkpoints')}>
                        Timeline <ArrowRight size={14} />
                    </button>
                </section>

                <section className="overview-card">
                    <header>
                        <Folder size={16} />
                        <h3>Where data lives</h3>
                    </header>
                    <dl className="overview-dl paths">
                        <div>
                            <dt>Project</dt>
                            <dd title={data?.projectPath}>{data?.projectPath || '—'}</dd>
                        </div>
                        <div>
                            <dt>Brain DB</dt>
                            <dd title={data?.brainDb}>{data?.brainDb || '~/.rigour/rigour.db'}</dd>
                        </div>
                    </dl>
                    <p className="overview-hint">
                        Studio reads Brain SQLite for cost/cache/checkpoints and merges project + global{' '}
                        <code>memory.json</code>.
                    </p>
                </section>
            </div>

            <div className="overview-quick-nav">
                <button type="button" onClick={() => onNavigate('cost')}>
                    <Coins size={16} /> Cost &amp; Context
                </button>
                <button type="button" onClick={() => onNavigate('checkpoints')}>
                    <Flag size={16} /> Checkpoints
                </button>
                <button type="button" onClick={() => onNavigate('memory')}>
                    <Brain size={16} /> Memory
                </button>
                <button type="button" onClick={() => onNavigate('patterns')}>
                    <Database size={16} /> Patterns
                </button>
            </div>
        </div>
    );
}
