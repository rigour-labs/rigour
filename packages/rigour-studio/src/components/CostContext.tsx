import React, { useState, useEffect } from 'react';
import {
    Zap,
    Coins,
    Layers,
    Upload,
    RefreshCw,
    Database,
    HelpCircle,
    ShieldCheck,
    AlertCircle,
    KeyRound,
    ChevronDown,
    Trash2,
} from 'lucide-react';

interface TaskContextStats {
    retrievals?: number;
    candidateTokens?: number;
    returnedTokens?: number;
    potentialAvoidedTokens?: number;
    cacheHitRate?: number;
    repeatedReadsPrevented?: number;
    checkpointReplayAvoided?: number;
    isEstimated?: boolean;
}

interface TaskCostStats {
    actual?: {
        inputTokens?: number;
        outputTokens?: number;
        costUsd?: number;
        source?: string;
        isEstimated?: boolean;
    };
    estimated?: {
        potentialContextAvoided?: number;
        estimatedCostAvoidedUsd?: number;
        isEstimated?: boolean;
    };
}

interface CachePerformanceStats {
    exactCacheHits?: number;
    semanticCacheHits?: number;
    partialCacheHits?: number;
    cacheMisses?: number;
    hitRate?: number;
    tokensServedFromCache?: number;
    isEstimated?: boolean;
}

interface ContextScopeSummary {
    overlappingScopesResolved?: number;
    alwaysOnRuleTokens?: number;
    unusedToolsFiltered?: number;
    activeAgentCount?: number;
}

interface CheckpointSummary {
    rawStateTokens?: number;
    checkpointTokens?: number;
    compressionRatio?: number;
    checkpointCount?: number;
    replayTokensAvoided?: number;
}

export function CostContext() {
    const [contextStats, setContextStats] = useState<TaskContextStats | null>(null);
    const [costStats, setCostStats] = useState<TaskCostStats | null>(null);
    const [cacheStats, setCacheStats] = useState<CachePerformanceStats | null>(null);
    const [scopeSummary, setScopeSummary] = useState<ContextScopeSummary | null>(null);
    const [checkpointSummary, setCheckpointSummary] = useState<CheckpointSummary | null>(null);
    const [explanation, setExplanation] = useState<any>(null);
    const [searchTarget, setSearchTarget] = useState('services/task');
    const [csvInput, setCsvInput] = useState('');
    const [importStatus, setImportStatus] = useState<string | null>(null);
    const [cursorApiKey, setCursorApiKey] = useState('');
    const [cursorKeyConfigured, setCursorKeyConfigured] = useState(false);
    const [cursorKeyHint, setCursorKeyHint] = useState<string | undefined>();
    const [cursorKeySource, setCursorKeySource] = useState<'env' | 'file' | 'none'>('none');
    const [cursorImportedCount, setCursorImportedCount] = useState(0);
    const [cursorSyncLoading, setCursorSyncLoading] = useState(false);
    const [cursorKeyStatus, setCursorKeyStatus] = useState<string | null>(null);
    const [vendorOpen, setVendorOpen] = useState(false);
    const [loading, setLoading] = useState(true);

    const fetchData = async () => {
        setLoading(true);
        try {
            const [ctxRes, costRes, cacheRes, scopeRes, checkpointRes, keyStatusRes] = await Promise.all([
                fetch('/api/context-stats').then((r) => r.json()),
                fetch('/api/task-cost').then((r) => r.json()),
                fetch('/api/cache-stats').then((r) => r.json()),
                fetch('/api/context-scope').then((r) => r.json()),
                fetch('/api/checkpoint-metrics').then((r) => r.json()),
                fetch('/api/cursor-api-key/status').then((r) => r.json()),
            ]);
            setContextStats(ctxRes);
            setCostStats(costRes);
            setCacheStats(cacheRes);
            setScopeSummary(scopeRes);
            setCheckpointSummary(checkpointRes);
            setCursorKeyConfigured(Boolean(keyStatusRes?.configured));
            setCursorKeyHint(keyStatusRes?.hint);
            setCursorKeySource(keyStatusRes?.source || 'none');
            setCursorImportedCount(Number(keyStatusRes?.importedCount ?? 0));
        } catch (e) {
            console.error('Failed to fetch cost & context telemetry', e);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchData();
    }, []);

    const handleExplain = async () => {
        if (!searchTarget) return;
        try {
            const res = await fetch(`/api/context-explain?target=${encodeURIComponent(searchTarget)}`);
            setExplanation(await res.json());
        } catch (e) {
            console.error('Failed to get context explanation', e);
        }
    };

    const handleCsvImport = async () => {
        if (!csvInput.trim()) return;
        try {
            const res = await fetch('/api/import-cursor-usage', {
                method: 'POST',
                headers: { 'Content-Type': 'text/plain' },
                body: csvInput,
            });
            const data = await res.json();
            if (data.success) {
                setImportStatus(`Imported ${data.importedCount} observed usage record(s).`);
                setCsvInput('');
                fetchData();
            } else {
                setImportStatus(`Import failed: ${data.error}`);
            }
        } catch (e: any) {
            setImportStatus(`Import failed: ${e.message}`);
        }
    };

    const handleSaveCursorApiKey = async () => {
        if (!cursorApiKey.trim()) return;
        setCursorSyncLoading(true);
        setCursorKeyStatus(null);
        try {
            const res = await fetch('/api/cursor-api-key', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ apiKey: cursorApiKey.trim() }),
            });
            const data = await res.json();
            if (data.success) {
                setCursorKeyConfigured(true);
                setCursorApiKey('');
                setCursorKeyHint(data.hint);
                setCursorKeySource(data.source || 'file');
                setCursorImportedCount(Number(data.importedCount ?? 0));
                setCursorKeyStatus(
                    data.syncError
                        ? `Key saved locally. Initial sync failed: ${data.syncError}`
                        : `Vendor key saved locally. Imported ${data.importedCount ?? 0} usage event(s).`,
                );
                fetchData();
            } else {
                setCursorKeyStatus(`Save failed: ${data.error}`);
            }
        } catch (e: any) {
            setCursorKeyStatus(`Save failed: ${e.message}`);
        } finally {
            setCursorSyncLoading(false);
        }
    };

    const handleRemoveCursorApiKey = async () => {
        setCursorSyncLoading(true);
        setCursorKeyStatus(null);
        try {
            const res = await fetch('/api/cursor-api-key', { method: 'DELETE' });
            const data = await res.json();
            if (data.success) {
                setCursorKeyConfigured(Boolean(data.configured));
                setCursorKeyHint(data.hint);
                setCursorKeySource(data.source || 'none');
                setCursorKeyStatus(
                    data.configured
                        ? 'Removed file key. Env key still active.'
                        : 'Removed local vendor key.',
                );
            } else {
                setCursorKeyStatus(`Remove failed: ${data.error}`);
            }
        } catch (e: any) {
            setCursorKeyStatus(`Remove failed: ${e.message}`);
        } finally {
            setCursorSyncLoading(false);
        }
    };

    const handleCursorSync = async () => {
        setCursorSyncLoading(true);
        setCursorKeyStatus(null);
        try {
            const res = await fetch('/api/cursor-sync', { method: 'POST' });
            const data = await res.json();
            if (data.success) {
                setCursorImportedCount(Number(data.importedCount ?? 0));
                setCursorKeyStatus(`Synced ${data.importedCount ?? 0} new usage event(s).`);
                fetchData();
            } else {
                setCursorKeyStatus(`Sync failed: ${data.error || 'Unknown error'}`);
            }
        } catch (e: any) {
            setCursorKeyStatus(`Sync failed: ${e.message}`);
        } finally {
            setCursorSyncLoading(false);
        }
    };

    const formatTokens = (num: number) => {
        if (!num) return '0';
        if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(2)}M`;
        if (num >= 1_000) return `${(num / 1_000).toFixed(1)}K`;
        return num.toString();
    };

    const candidateTokens = contextStats?.candidateTokens ?? 0;
    const returnedTokens = contextStats?.returnedTokens ?? 0;
    const potentialAvoided = contextStats?.potentialAvoidedTokens ?? 0;
    const reductionRatio =
        candidateTokens > 0 ? (((candidateTokens - returnedTokens) / candidateTokens) * 100).toFixed(1) : '0.0';
    const cacheHitRatePct = cacheStats?.hitRate ? Math.round(cacheStats.hitRate * 100) : 0;
    const actualCost = costStats?.actual?.costUsd ?? 0;
    const estimatedAvoidedCost = costStats?.estimated?.estimatedCostAvoidedUsd ?? 0;
    const actualInputTokens = costStats?.actual?.inputTokens ?? 0;
    const costSource = costStats?.actual?.source || 'No usage data';

    const hasTelemetryData =
        (contextStats?.retrievals ?? 0) > 0 ||
        actualInputTokens > 0 ||
        (cacheStats?.exactCacheHits ?? 0) +
            (cacheStats?.semanticCacheHits ?? 0) +
            (cacheStats?.partialCacheHits ?? 0) +
            (cacheStats?.cacheMisses ?? 0) >
            0 ||
        (checkpointSummary?.checkpointCount ?? 0) > 0;

    return (
        <div className="cost-context-view">
            <div className="cost-header">
                <div>
                    <h2>
                        <Zap size={20} className="text-amber" />
                        Token Savings & Context Efficiency
                    </h2>
                    <p>Rigour-measured avoided context vs optional observed model usage (kept separate on purpose).</p>
                </div>
                <div className="cost-toolbar">
                    <button type="button" onClick={fetchData} aria-label="Refresh cost and context stats">
                        <RefreshCw size={14} className={loading ? 'spinning' : ''} /> Refresh
                    </button>
                </div>
            </div>

            {!hasTelemetryData && !loading && (
                <div className="cost-banner">
                    <AlertCircle size={18} className="text-amber" />
                    <div>
                        <strong>No telemetry recorded yet</strong>
                        <p>
                            Use Rigour MCP tools (<code>rigour_context_scope</code>, <code>rigour_checkpoint</code>) or
                            import observed usage below.
                        </p>
                    </div>
                </div>
            )}

            <div className="cost-kpi-grid">
                <div className="cost-kpi-card glass-card">
                    <div className="label">Actual model tokens</div>
                    <div className="value">{formatTokens(actualInputTokens)}</div>
                    <div className="meta text-emerald">Observed via {costSource}</div>
                </div>
                <div className="cost-kpi-card glass-card">
                    <div className="label">Potential context avoided</div>
                    <div className="value text-amber">{formatTokens(potentialAvoided)}</div>
                    <div className="meta">Reduction ratio: {reductionRatio}%</div>
                </div>
                <div className="cost-kpi-card glass-card">
                    <div className="label">Cache hit rate</div>
                    <div className="value text-cyan">{cacheHitRatePct}%</div>
                    <div className="meta">static &amp; semantic layers</div>
                </div>
                <div className="cost-kpi-card glass-card">
                    <div className="label">Actual vs avoided cost</div>
                    <div className="value">
                        <span className="text-emerald">${actualCost.toFixed(2)}</span>
                        {' / '}
                        <span className="text-amber">${estimatedAvoidedCost.toFixed(2)}</span>
                    </div>
                    <div className="meta">Actual spend / est. avoided</div>
                </div>
            </div>

            <div className="cost-panel-grid">
                <div className="cost-panel glass-card">
                    <h3>
                        <Layers size={16} className="text-cyan" /> A. Retrieval efficiency
                    </h3>
                    <div className="cost-row">
                        <span>Candidates scanned</span>
                        <span>{formatTokens(candidateTokens)} tokens</span>
                    </div>
                    <div className="cost-row">
                        <span>Context returned</span>
                        <span className="text-cyan">{formatTokens(returnedTokens)} tokens</span>
                    </div>
                    <div className="cost-row">
                        <span>Potential avoided</span>
                        <span className="text-amber">{formatTokens(potentialAvoided)} tokens</span>
                    </div>
                    <div className="cost-row">
                        <span>Reduction ratio</span>
                        <span className="text-emerald">{reductionRatio}%</span>
                    </div>
                </div>

                <div className="cost-panel glass-card">
                    <h3>
                        <Database size={16} className="text-emerald" /> B. Cache efficiency
                    </h3>
                    <div className="cost-hit-grid">
                        <div>
                            Exact hits
                            <strong className="text-emerald">{cacheStats?.exactCacheHits ?? 0}</strong>
                        </div>
                        <div>
                            Semantic hits
                            <strong className="text-cyan">{cacheStats?.semanticCacheHits ?? 0}</strong>
                        </div>
                        <div>
                            Partial hits
                            <strong className="text-amber">{cacheStats?.partialCacheHits ?? 0}</strong>
                        </div>
                        <div>
                            Misses
                            <strong className="text-rose">{cacheStats?.cacheMisses ?? 0}</strong>
                        </div>
                    </div>
                    <div className="cost-row">
                        <span>Tokens served from cache</span>
                        <span className="text-emerald">{formatTokens(cacheStats?.tokensServedFromCache ?? 0)}</span>
                    </div>
                </div>

                <div className="cost-panel glass-card">
                    <h3>
                        <ShieldCheck size={16} className="text-purple" /> C. Duplication prevention
                    </h3>
                    <div className="cost-row">
                        <span>Repeated reads prevented</span>
                        <span className="text-emerald">{contextStats?.repeatedReadsPrevented ?? 0}</span>
                    </div>
                    <div className="cost-row">
                        <span>Overlapping scopes resolved</span>
                        <span className="text-cyan">{scopeSummary?.overlappingScopesResolved ?? 0}</span>
                    </div>
                    <div className="cost-row">
                        <span>Always-on rule tokens</span>
                        <span>{formatTokens(scopeSummary?.alwaysOnRuleTokens ?? 0)}</span>
                    </div>
                    <div className="cost-row">
                        <span>Unused tools filtered</span>
                        <span className="text-purple">{scopeSummary?.unusedToolsFiltered ?? 0}</span>
                    </div>
                </div>

                <div className="cost-panel glass-card">
                    <h3>
                        <Coins size={16} className="text-amber" /> D. Checkpoint compression
                    </h3>
                    <div className="cost-row">
                        <span>Raw session state</span>
                        <span>{formatTokens(checkpointSummary?.rawStateTokens ?? 0)}</span>
                    </div>
                    <div className="cost-row">
                        <span>Checkpoint packet size</span>
                        <span className="text-emerald">
                            {formatTokens(checkpointSummary?.checkpointTokens ?? 0)}
                            {(checkpointSummary?.compressionRatio ?? 0) > 0
                                ? ` (${checkpointSummary?.compressionRatio}×)`
                                : ''}
                        </span>
                    </div>
                    <div className="cost-row">
                        <span>Observed model cost</span>
                        <span className="text-emerald">${actualCost.toFixed(2)}</span>
                    </div>
                    <div className="cost-row">
                        <span>Estimated avoided spend</span>
                        <span className="text-amber">${estimatedAvoidedCost.toFixed(2)}</span>
                    </div>
                </div>
            </div>

            <div className="cost-panel glass-card">
                <h3>
                    <HelpCircle size={16} className="text-cyan" /> Context explainability
                </h3>
                <div className="cost-explain-row">
                    <label className="sr-only" htmlFor="context-explain-target">
                        File, service, or query
                    </label>
                    <input
                        id="context-explain-target"
                        type="text"
                        value={searchTarget}
                        onChange={(e) => setSearchTarget(e.target.value)}
                        placeholder="File, service, or query (e.g. services/task)"
                    />
                    <button type="button" className="cost-primary" onClick={handleExplain}>
                        Explain
                    </button>
                </div>
                {explanation && (
                    <div className="cost-row" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 6 }}>
                        <div>
                            Target: <strong>{explanation.fileOrService}</strong> [{String(explanation.status || '').toUpperCase()}]
                        </div>
                        <div>Reason: {explanation.reason}</div>
                        <div>
                            Cache: <span className="text-cyan">{explanation.cacheStatus}</span>
                        </div>
                    </div>
                )}
            </div>

            <div className="cost-panel glass-card">
                <h3>
                    <Upload size={16} className="text-amber" /> Import observed model usage
                </h3>
                <p className="cost-panel-help">
                    Vendor-agnostic CSV/JSON import for actual token spend. Does not require any Admin API key.
                </p>
                <label className="sr-only" htmlFor="observed-usage-import">
                    Observed usage CSV or JSON
                </label>
                <textarea
                    id="observed-usage-import"
                    rows={4}
                    value={csvInput}
                    onChange={(e) => setCsvInput(e.target.value)}
                    placeholder={`Date,Model,Input Tokens,Output Tokens,Cost\n2026-08-05,claude-3-5-sonnet,510000,62000,4.83`}
                    style={{ marginBottom: 10 }}
                />
                <div className="cost-actions">
                    <button type="button" className="cost-primary" onClick={handleCsvImport}>
                        Import usage data
                    </button>
                    {importStatus && (
                        <span
                            role="alert"
                            className={importStatus.includes('failed') ? 'text-rose' : 'text-emerald'}
                            style={{ fontSize: '0.78rem' }}
                        >
                            {importStatus}
                        </span>
                    )}
                </div>
            </div>

            <div className="cost-panel glass-card vendor-adapters">
                <button
                    type="button"
                    className="vendor-adapters-toggle"
                    onClick={() => setVendorOpen((o) => !o)}
                    aria-expanded={vendorOpen}
                >
                    <span>
                        <KeyRound size={16} className="text-cyan" /> Vendor adapters
                    </span>
                    <ChevronDown size={16} className={vendorOpen ? 'rotated' : ''} />
                </button>
                {vendorOpen && (
                    <div className="vendor-adapters-body">
                        <h4>Cursor Admin API (optional)</h4>
                        <p className="cost-panel-help">
                            Optional verification for teams that already use Cursor Admin API. Rigour does not require this.
                            Prefer <code>RIGOUR_CURSOR_API_KEY</code> or <code>CURSOR_ADMIN_API_KEY</code> in the environment.
                            File storage stays on this machine only (<code>~/.rigour/settings.json</code>, mode 600).
                        </p>
                        <p className="cost-panel-help">
                            {cursorKeyConfigured
                                ? `Configured${cursorKeyHint ? ` (${cursorKeyHint})` : ''} via ${cursorKeySource}.${cursorImportedCount > 0 ? ` ${cursorImportedCount} event(s) imported.` : ''}`
                                : 'No vendor key configured.'}
                        </p>
                        <div className="cost-actions" style={{ marginBottom: 8 }}>
                            <label className="sr-only" htmlFor="cursor-vendor-key">
                                Cursor Admin API key
                            </label>
                            <input
                                id="cursor-vendor-key"
                                type="password"
                                autoComplete="off"
                                value={cursorApiKey}
                                onChange={(e) => setCursorApiKey(e.target.value)}
                                placeholder="Paste key only if not using env"
                                disabled={cursorSyncLoading}
                            />
                            <button
                                type="button"
                                className="cost-primary"
                                onClick={handleSaveCursorApiKey}
                                disabled={cursorSyncLoading || !cursorApiKey.trim()}
                            >
                                {cursorSyncLoading ? 'Saving…' : 'Save key'}
                            </button>
                            <button
                                type="button"
                                onClick={handleCursorSync}
                                disabled={cursorSyncLoading || !cursorKeyConfigured}
                                aria-label="Sync Cursor usage"
                            >
                                <RefreshCw size={14} className={cursorSyncLoading ? 'spinning' : ''} />
                                Sync
                            </button>
                            <button
                                type="button"
                                onClick={handleRemoveCursorApiKey}
                                disabled={cursorSyncLoading || cursorKeySource === 'env' || !cursorKeyConfigured}
                                aria-label="Remove local Cursor API key"
                                title={cursorKeySource === 'env' ? 'Remove env var in your shell' : 'Remove file key'}
                            >
                                <Trash2 size={14} />
                                Remove
                            </button>
                        </div>
                        {cursorKeyStatus && (
                            <span
                                role="alert"
                                className={cursorKeyStatus.includes('failed') ? 'text-rose' : 'text-emerald'}
                                style={{ fontSize: '0.78rem' }}
                            >
                                {cursorKeyStatus}
                            </span>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}
