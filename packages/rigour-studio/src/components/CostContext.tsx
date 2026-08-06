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
} from 'lucide-react';
import { motion } from 'framer-motion';

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
    const [cursorImportedCount, setCursorImportedCount] = useState(0);
    const [cursorSyncLoading, setCursorSyncLoading] = useState(false);
    const [cursorKeyStatus, setCursorKeyStatus] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);

    const fetchData = async () => {
        setLoading(true);
        try {
            const [ctxRes, costRes, cacheRes, scopeRes, checkpointRes, keyStatusRes] = await Promise.all([
                fetch('/api/context-stats').then(r => r.json()),
                fetch('/api/task-cost').then(r => r.json()),
                fetch('/api/cache-stats').then(r => r.json()),
                fetch('/api/context-scope').then(r => r.json()),
                fetch('/api/checkpoint-metrics').then(r => r.json()),
                fetch('/api/cursor-api-key/status').then(r => r.json()),
            ]);
            setContextStats(ctxRes);
            setCostStats(costRes);
            setCacheStats(cacheRes);
            setScopeSummary(scopeRes);
            setCheckpointSummary(checkpointRes);
            setCursorKeyConfigured(Boolean(keyStatusRes?.configured));
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
            const data = await res.json();
            setExplanation(data);
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
                body: csvInput
            });
            const data = await res.json();
            if (data.success) {
                setImportStatus(`Successfully imported ${data.importedCount} usage records!`);
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
                setCursorImportedCount(Number(data.importedCount ?? 0));
                if (data.syncError) {
                    setCursorKeyStatus(`Key saved. Initial sync failed: ${data.syncError}`);
                } else {
                    setCursorKeyStatus(
                        `Cursor Admin API key saved. Imported ${data.importedCount ?? 0} usage event(s).`,
                    );
                }
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

    const handleCursorSync = async () => {
        setCursorSyncLoading(true);
        setCursorKeyStatus(null);
        try {
            const res = await fetch('/api/cursor-sync', { method: 'POST' });
            const data = await res.json();
            if (data.success) {
                setCursorImportedCount(Number(data.importedCount ?? 0));
                setCursorKeyStatus(`Synced ${data.importedCount ?? 0} new Cursor usage event(s).`);
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
    const reductionRatio = candidateTokens > 0
        ? (((candidateTokens - returnedTokens) / candidateTokens) * 100).toFixed(1)
        : '0.0';
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
            (cacheStats?.cacheMisses ?? 0) > 0 ||
        (checkpointSummary?.checkpointCount ?? 0) > 0;

    return (
        <div className="cost-context-view space-y-6">
            <div className="flex items-center justify-between border-b border-border pb-4">
                <div>
                    <h2 className="text-xl font-bold flex items-center gap-2 text-primary">
                        <Zap size={22} className="text-amber-400" />
                        Token Savings & Context Efficiency Telemetry
                    </h2>
                    <p className="text-sm text-muted-foreground mt-1">
                        Two-layer context tracking: Exact observed Cursor usage & Rigour-measured avoided context
                    </p>
                </div>
                <button onClick={fetchData} className="px-3 py-1.5 bg-secondary text-secondary-foreground rounded-md flex items-center gap-2 hover:bg-secondary/80 text-sm transition">
                    <RefreshCw size={14} className={loading ? "animate-spin" : ""} /> Refresh
                </button>
            </div>

            {!hasTelemetryData && !loading && (
                <div className="p-4 bg-amber-500/10 border border-amber-500/30 rounded-lg flex items-start gap-3">
                    <AlertCircle size={20} className="text-amber-400 mt-0.5 shrink-0" />
                    <div className="text-sm">
                        <p className="font-semibold text-amber-300">No telemetry recorded yet</p>
                        <p className="text-muted-foreground mt-1">
                            Use Rigour MCP tools (rigour_context_stats, rigour_checkpoint, rigour_recall) or import Cursor usage data below.
                            Metrics will show real values once agents interact with the project.
                        </p>
                    </div>
                </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="p-4 bg-card border border-border rounded-lg shadow-sm">
                    <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Actual Model Tokens</div>
                    <div className="text-2xl font-bold text-foreground mt-1">{formatTokens(actualInputTokens)}</div>
                    <div className="text-xs text-emerald-400 mt-1">Observed via {costSource}</div>
                </motion.div>

                <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }} className="p-4 bg-card border border-border rounded-lg shadow-sm">
                    <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Potential Context Avoided</div>
                    <div className="text-2xl font-bold text-amber-400 mt-1">{formatTokens(potentialAvoided)}</div>
                    <div className="text-xs text-amber-300 mt-1">Reduction Ratio: {reductionRatio}%</div>
                </motion.div>

                <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }} className="p-4 bg-card border border-border rounded-lg shadow-sm">
                    <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Cache Hit Rate</div>
                    <div className="text-2xl font-bold text-cyan-400 mt-1">{cacheHitRatePct}%</div>
                    <div className="text-xs text-muted-foreground mt-1">across static & semantic layers</div>
                </motion.div>

                <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.3 }} className="p-4 bg-card border border-border rounded-lg shadow-sm">
                    <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Actual vs Avoided Cost</div>
                    <div className="text-2xl font-bold text-emerald-400 mt-1">${actualCost.toFixed(2)} / <span className="text-amber-400">${estimatedAvoidedCost.toFixed(2)}</span></div>
                    <div className="text-xs text-muted-foreground mt-1">Actual Spend / Est. Cost Avoided</div>
                </motion.div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="p-5 bg-card border border-border rounded-lg shadow-sm">
                    <h3 className="text-md font-semibold text-foreground flex items-center gap-2 mb-3">
                        <Layers size={18} className="text-cyan-400" /> A. Retrieval Efficiency
                    </h3>
                    <div className="space-y-2 text-sm">
                        <div className="flex justify-between py-1 border-b border-border/50">
                            <span className="text-muted-foreground">Context Candidates Scanned</span>
                            <span className="font-mono text-foreground">{formatTokens(candidateTokens)} tokens</span>
                        </div>
                        <div className="flex justify-between py-1 border-b border-border/50">
                            <span className="text-muted-foreground">Context Returned</span>
                            <span className="font-mono text-cyan-400">{formatTokens(returnedTokens)} tokens</span>
                        </div>
                        <div className="flex justify-between py-1 border-b border-border/50">
                            <span className="text-muted-foreground">Potential Context Avoided</span>
                            <span className="font-mono text-amber-400">{formatTokens(potentialAvoided)} tokens</span>
                        </div>
                        <div className="flex justify-between py-1">
                            <span className="text-muted-foreground">Context Reduction Ratio</span>
                            <span className="font-semibold text-emerald-400">{reductionRatio}%</span>
                        </div>
                    </div>
                </div>

                <div className="p-5 bg-card border border-border rounded-lg shadow-sm">
                    <h3 className="text-md font-semibold text-foreground flex items-center gap-2 mb-3">
                        <Database size={18} className="text-emerald-400" /> B. Cache Efficiency (4-Layer Engine)
                    </h3>
                    <div className="grid grid-cols-2 gap-3 mb-3 text-xs">
                        <div className="p-2 bg-background rounded border border-border">
                            <div className="text-muted-foreground">Exact Cache Hits</div>
                            <div className="text-base font-bold text-emerald-400">{cacheStats?.exactCacheHits ?? 0}</div>
                        </div>
                        <div className="p-2 bg-background rounded border border-border">
                            <div className="text-muted-foreground">Semantic Cache Hits</div>
                            <div className="text-base font-bold text-cyan-400">{cacheStats?.semanticCacheHits ?? 0}</div>
                        </div>
                        <div className="p-2 bg-background rounded border border-border">
                            <div className="text-muted-foreground">Partial Cache Hits</div>
                            <div className="text-base font-bold text-amber-400">{cacheStats?.partialCacheHits ?? 0}</div>
                        </div>
                        <div className="p-2 bg-background rounded border border-border">
                            <div className="text-muted-foreground">Cache Misses</div>
                            <div className="text-base font-bold text-rose-400">{cacheStats?.cacheMisses ?? 0}</div>
                        </div>
                    </div>
                    <div className="flex justify-between text-xs pt-1 border-t border-border/50">
                        <span className="text-muted-foreground">Tokens Served from Cache</span>
                        <span className="font-mono text-emerald-400">{formatTokens(cacheStats?.tokensServedFromCache ?? 0)} tokens</span>
                    </div>
                </div>

                <div className="p-5 bg-card border border-border rounded-lg shadow-sm">
                    <h3 className="text-md font-semibold text-foreground flex items-center gap-2 mb-3">
                        <ShieldCheck size={18} className="text-purple-400" /> C & D. Duplication & Overhead Prevention
                    </h3>
                    <div className="space-y-2 text-sm">
                        <div className="flex justify-between py-1 border-b border-border/50">
                            <span className="text-muted-foreground">Repeated File Reads Prevented</span>
                            <span className="font-mono text-emerald-400">{contextStats?.repeatedReadsPrevented ?? 0} reads</span>
                        </div>
                        <div className="flex justify-between py-1 border-b border-border/50">
                            <span className="text-muted-foreground">Overlapping Agent Scopes Resolved</span>
                            <span className="font-mono text-cyan-400">{scopeSummary?.overlappingScopesResolved ?? 0} scopes</span>
                        </div>
                        <div className="flex justify-between py-1 border-b border-border/50">
                            <span className="text-muted-foreground">Always-On Rule & MCP Tokens</span>
                            <span className="font-mono text-foreground">{formatTokens(scopeSummary?.alwaysOnRuleTokens ?? 0)} tokens</span>
                        </div>
                        <div className="flex justify-between py-1">
                            <span className="text-muted-foreground">Unused Tools Filtered</span>
                            <span className="font-mono text-purple-400">{scopeSummary?.unusedToolsFiltered ?? 0} schema tools hidden</span>
                        </div>
                    </div>
                </div>

                <div className="p-5 bg-card border border-border rounded-lg shadow-sm">
                    <h3 className="text-md font-semibold text-foreground flex items-center gap-2 mb-3">
                        <Coins size={18} className="text-amber-400" /> E & F. Checkpoint Compression & Cost Audit
                    </h3>
                    <div className="space-y-2 text-sm">
                        <div className="flex justify-between py-1 border-b border-border/50">
                            <span className="text-muted-foreground">Raw Session State</span>
                            <span className="font-mono text-foreground">{formatTokens(checkpointSummary?.rawStateTokens ?? 0)} tokens</span>
                        </div>
                        <div className="flex justify-between py-1 border-b border-border/50">
                            <span className="text-muted-foreground">Checkpoint Packet Size</span>
                            <span className="font-mono text-emerald-400">
                                {formatTokens(checkpointSummary?.checkpointTokens ?? 0)} tokens
                                {(checkpointSummary?.compressionRatio ?? 0) > 0
                                    ? ` (${checkpointSummary?.compressionRatio}× compression)`
                                    : ''}
                            </span>
                        </div>
                        <div className="flex justify-between py-1 border-b border-border/50">
                            <span className="text-muted-foreground">Verified Cursor Cost</span>
                            <span className="font-mono text-emerald-400">${actualCost.toFixed(2)} USD</span>
                        </div>
                        <div className="flex justify-between py-1">
                            <span className="text-muted-foreground">Estimated Avoided Spend</span>
                            <span className="font-mono text-amber-400 font-bold">${estimatedAvoidedCost.toFixed(2)} USD</span>
                        </div>
                    </div>
                </div>
            </div>

            <div className="p-5 bg-card border border-border rounded-lg shadow-sm">
                <h3 className="text-md font-semibold text-foreground flex items-center gap-2 mb-3">
                    <HelpCircle size={18} className="text-cyan-400" /> Auditable Context Explainability (rigour_context_explain)
                </h3>
                <div className="flex gap-2 mb-4">
                    <input
                        type="text"
                        value={searchTarget}
                        onChange={(e) => setSearchTarget(e.target.value)}
                        placeholder="Enter file, service, or query target (e.g. services/task)"
                        className="flex-1 px-3 py-2 bg-background border border-border rounded-md text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                    />
                    <button onClick={handleExplain} className="px-4 py-2 bg-primary text-primary-foreground text-sm rounded-md hover:bg-primary/90 font-medium">
                        Explain Context
                    </button>
                </div>

                {explanation && (
                    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="p-4 bg-background border border-border rounded-md text-xs space-y-2">
                        <div className="flex justify-between font-mono">
                            <span className="text-muted-foreground">Target: <strong className="text-foreground">{explanation.fileOrService}</strong></span>
                            <span className={explanation.status === 'included' ? "text-emerald-400 font-bold" : "text-rose-400 font-bold"}>
                                [{explanation.status.toUpperCase()}]
                            </span>
                        </div>
                        <div className="text-muted-foreground">Reason: <span className="text-foreground">{explanation.reason}</span></div>
                        <div className="text-muted-foreground">Cache Status: <span className="text-cyan-400">{explanation.cacheStatus}</span></div>
                        {explanation.priorAgentRequests && explanation.priorAgentRequests.length > 0 && (
                            <div>
                                <div className="text-muted-foreground mb-1">Prior Agent Interactions:</div>
                                <ul className="list-disc pl-4 space-y-1 text-foreground font-mono">
                                    {explanation.priorAgentRequests.map((req: string, idx: number) => (
                                        <li key={idx}>{req}</li>
                                    ))}
                                </ul>
                            </div>
                        )}
                    </motion.div>
                )}
            </div>

            <div className="p-5 bg-card border border-border rounded-lg shadow-sm">
                <h3 className="text-md font-semibold text-foreground flex items-center gap-2 mb-3">
                    <KeyRound size={18} className="text-cyan-400" /> Cursor Admin API Key
                </h3>
                <p className="text-xs text-muted-foreground mb-3">
                    Optional: save your Cursor Admin API key to enable verified usage sync.
                    {cursorKeyConfigured ? ' Key is configured.' : ' No key configured yet.'}
                    {cursorImportedCount > 0 ? ` ${cursorImportedCount} Admin API event(s) imported.` : ''}
                </p>
                <div className="flex gap-2 mb-2">
                    <input
                        type="password"
                        value={cursorApiKey}
                        onChange={(e) => setCursorApiKey(e.target.value)}
                        placeholder="Cursor Admin API key"
                        disabled={cursorSyncLoading}
                        className="flex-1 px-3 py-2 bg-background border border-border rounded-md text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-60"
                    />
                    <button
                        onClick={handleSaveCursorApiKey}
                        disabled={cursorSyncLoading || !cursorApiKey.trim()}
                        className="px-4 py-2 bg-primary text-primary-foreground text-sm rounded-md hover:bg-primary/90 font-medium disabled:opacity-60"
                    >
                        {cursorSyncLoading ? 'Saving…' : 'Save Key'}
                    </button>
                    <button
                        onClick={handleCursorSync}
                        disabled={cursorSyncLoading || !cursorKeyConfigured}
                        className="px-4 py-2 bg-secondary text-secondary-foreground text-sm rounded-md hover:bg-secondary/80 font-medium disabled:opacity-60 flex items-center gap-2"
                    >
                        <RefreshCw size={14} className={cursorSyncLoading ? 'animate-spin' : ''} />
                        {cursorSyncLoading ? 'Syncing…' : 'Sync Cursor'}
                    </button>
                </div>
                {cursorKeyStatus && (
                    <span className={`text-xs font-semibold ${cursorKeyStatus.includes('failed') ? 'text-rose-400' : 'text-emerald-400'}`}>
                        {cursorKeyStatus}
                    </span>
                )}
            </div>

            <div className="p-5 bg-card border border-border rounded-lg shadow-sm">
                <h3 className="text-md font-semibold text-foreground flex items-center gap-2 mb-3">
                    <Upload size={18} className="text-amber-400" /> Import Cursor Daily Spend / Admin Usage
                </h3>
                <p className="text-xs text-muted-foreground mb-3">
                    Paste CSV or JSON exported from Cursor Dashboard or Admin API to reconcile verified model usage.
                </p>
                <textarea
                    rows={4}
                    value={csvInput}
                    onChange={(e) => setCsvInput(e.target.value)}
                    placeholder={`Date,Model,Input Tokens,Output Tokens,Cost\n2026-08-05,claude-3-5-sonnet,510000,62000,4.83`}
                    className="w-full p-3 bg-background border border-border rounded-md font-mono text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary mb-3"
                />
                <div className="flex items-center justify-between">
                    <button onClick={handleCsvImport} className="px-4 py-2 bg-amber-500 text-black text-sm rounded-md font-semibold hover:bg-amber-400 transition">
                        Import Usage Data
                    </button>
                    {importStatus && <span className="text-xs font-semibold text-emerald-400">{importStatus}</span>}
                </div>
            </div>
        </div>
    );
}
