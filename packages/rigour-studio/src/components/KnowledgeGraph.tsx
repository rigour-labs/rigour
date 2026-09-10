import React from 'react';
import { AlertTriangle, Brain, Database, GitBranch, Network, RefreshCw, Search, ShieldCheck, Sparkles } from 'lucide-react';
import { ImpactGraphCanvas } from './graph/ImpactGraphCanvas';
import { NODE_COLORS, selectGraphData } from './graph/graph-model';
import type { GraphData, GraphNodeType, GraphPerspective, GraphSelection } from './graph/types';

const PERSPECTIVES: Array<{ id: GraphPerspective; label: string }> = [
    { id: 'impact', label: 'Improvement' },
    { id: 'code', label: 'Code structure' },
    { id: 'knowledge', label: 'Learning' },
    { id: 'all', label: 'Everything' },
];

const EXPERTISE_PERSPECTIVES: Array<{ id: GraphPerspective; label: string }> = [
    { id: 'knowledge', label: 'Knowledge network' },
    { id: 'code', label: 'Patterns & code' },
    { id: 'impact', label: 'Reuse & outcomes' },
    { id: 'all', label: 'All evidence' },
];

const LEGEND_TYPES: GraphNodeType[] = ['repository', 'file', 'agent', 'run', 'advice', 'pattern', 'memory', 'lesson', 'policy', 'outcome'];

function evidenceNumber(value: unknown): string | null {
    return typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString() : null;
}

function Inspector({ selection }: { selection: GraphSelection | null }) {
    if (!selection) return (
        <aside className="graph-inspector graph-inspector-empty">
            <Network size={28} />
            <h3>Select anything</h3>
            <p>Click a node to isolate its evidence trail and understand why it matters.</p>
        </aside>
    );
    const { node, neighbours, relationshipCount } = selection;
    const avoidedTokens = evidenceNumber(node.evidence?.avoidedTokens);
    const returnedTokens = evidenceNumber(node.evidence?.returnedTokens);
    const excludedFiles = evidenceNumber(node.evidence?.excludedFiles);
    return (
        <aside className="graph-inspector" aria-live="polite">
            <span className="node-type-badge" style={{ color: NODE_COLORS[node.type] }}>{node.type}</span>
            <h3>{node.label}</h3>
            <p>{node.detail || 'No additional detail recorded.'}</p>
            <dl className="graph-facts">
                {node.state && <div><dt>Evidence state</dt><dd>{node.state}</dd></div>}
                <div><dt>Relationships</dt><dd>{relationshipCount}</dd></div>
                <div><dt>Why shown</dt><dd>{node.type === 'file' ? 'Structural or touched dependency' : node.type === 'advice' ? 'Guidance issued by Rigour during agent work' : 'Recorded engineering evidence'}</dd></div>
                {avoidedTokens && <div><dt>Context avoided</dt><dd>{avoidedTokens} tokens · measured estimate</dd></div>}
                {returnedTokens && <div><dt>Context returned</dt><dd>{returnedTokens} tokens</dd></div>}
                {excludedFiles && <div><dt>Repository files excluded</dt><dd>{excludedFiles}</dd></div>}
            </dl>
            <div className="graph-neighbours">
                <strong>Connected evidence</strong>
                {neighbours.slice(0, 8).map(related => <span key={related.id}><i style={{ background: NODE_COLORS[related.type] }} />{related.label}</span>)}
                {neighbours.length === 0 && <span>No direct relationships recorded.</span>}
            </div>
        </aside>
    );
}

interface KnowledgeGraphProps {
    mode?: 'impact' | 'expertise';
    onNavigate?: (tab: string) => void;
}

interface ExpertiseSignals {
    deepFindings: number;
    driftScans: number;
    driftDirection: string;
}

export function KnowledgeGraph({ mode = 'impact', onNavigate }: KnowledgeGraphProps) {
    const [data, setData] = React.useState<GraphData | null>(null);
    const [error, setError] = React.useState('');
    const [loading, setLoading] = React.useState(true);
    const [query, setQuery] = React.useState('');
    const [perspective, setPerspective] = React.useState<GraphPerspective>(mode === 'expertise' ? 'knowledge' : 'impact');
    const [selection, setSelection] = React.useState<GraphSelection | null>(null);
    const [recentEvents, setRecentEvents] = React.useState<Array<{ id: string; tool?: string; type?: string; outcome: string; summary?: string }>>([]);
    const [expertiseSignals, setExpertiseSignals] = React.useState<ExpertiseSignals>({ deepFindings: 0, driftScans: 0, driftDirection: 'not measured' });

    const load = React.useCallback(async () => {
        setLoading(true);
        setError('');
        try {
            const [response, historyResponse, deepResponse, driftResponse] = await Promise.all([
                fetch('/api/knowledge-graph'),
                fetch('/api/agent-history?limit=12'),
                mode === 'expertise' ? fetch('/api/deep-findings') : Promise.resolve(null),
                mode === 'expertise' ? fetch('/api/drift') : Promise.resolve(null),
            ]);
            const payload = await response.json();
            if (!response.ok || payload.error) throw new Error(payload.error || `HTTP ${response.status}`);
            if (!Array.isArray(payload.nodes) || !Array.isArray(payload.edges) || typeof payload.counts !== 'object') {
                throw new Error('Studio received an invalid graph response.');
            }
            setData(payload);
            if (historyResponse.ok) {
                const history = await historyResponse.json();
                setRecentEvents(Array.isArray(history.events) ? history.events.slice(0, 6) : []);
            }
            if (mode === 'expertise') {
                const deep = deepResponse?.ok ? await deepResponse.json() : [];
                const drift = driftResponse?.ok ? await driftResponse.json() : {};
                setExpertiseSignals({
                    deepFindings: Array.isArray(deep) ? deep.length : 0,
                    driftScans: Number(drift.totalScans) || 0,
                    driftDirection: typeof drift.overallDirection === 'string' ? drift.overallDirection : 'not measured',
                });
            }
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : String(reason));
        } finally {
            setLoading(false);
        }
    }, [mode]);

    React.useEffect(() => { void load(); }, [load]);
    React.useEffect(() => setSelection(null), [perspective, query]);

    const visible = React.useMemo(
        () => data ? selectGraphData(data, perspective, query) : null,
        [data, perspective, query],
    );
    const visibleIds = React.useMemo(() => new Set(visible?.nodes.map(node => node.id) ?? []), [visible]);
    const renderData = React.useMemo(() => visible ? {
        ...visible,
        edges: visible.edges.filter(edge => visibleIds.has(edge.from) && visibleIds.has(edge.to)),
    } : null, [visible, visibleIds]);
    const perspectives = mode === 'expertise' ? EXPERTISE_PERSPECTIVES : PERSPECTIVES;
    const lessonNodes = data?.nodes.filter(node => node.type === 'lesson') ?? [];
    const validatedLessons = lessonNodes.filter(node => node.state === 'validated' || node.state === 'promoted').length;

    return (
        <section className="knowledge-graph" aria-labelledby="knowledge-graph-title">
            <div className="knowledge-hero">
                <div>
                    <span className="knowledge-eyebrow">{mode === 'expertise' ? 'Rigour SME growth graph' : 'Rigour impact graph'}</span>
                    <h1 id="knowledge-graph-title">{mode === 'expertise' ? 'See Rigour become your team’s SME' : 'See how agents improve your codebase'}</h1>
                    <p>{mode === 'expertise'
                        ? 'Every governed interaction becomes evidence. Patterns, memory and verified outcomes mature into reusable personal and team judgment.'
                        : 'Code structure, agent actions, prevented risks, proof and reusable team judgment—connected in one evidence map.'}</p>
                </div>
                <div className="knowledge-impact">
                    <span><ShieldCheck size={15} /><b>{mode === 'expertise' ? validatedLessons : (data?.counts.outcome ?? 0)}</b> {mode === 'expertise' ? 'validated' : 'outcomes'}</span>
                    <span><Sparkles size={15} /><b>{data?.counts.advice ?? 0}</b> advice issued</span>
                    <span><Database size={15} /><b>Local</b> offline-ready</span>
                </div>
            </div>
            <div className="knowledge-toolbar">
                <div className="segmented-control" role="tablist" aria-label="Graph perspective">
                    {perspectives.map(item => <button key={item.id} type="button" role="tab" aria-selected={perspective === item.id} className={perspective === item.id ? 'active' : ''} onClick={() => setPerspective(item.id)}>{item.label}</button>)}
                </div>
                <label className="graph-search"><Search size={15} /><span className="sr-only">Search graph</span><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Find agent, file, risk, pattern or lesson" /></label>
                <button type="button" className="refresh-btn" onClick={load} disabled={loading}><RefreshCw size={14} className={loading ? 'spinning' : ''} />Refresh</button>
            </div>
            {mode === 'expertise' && (
                <div className="expertise-journey" aria-label="Knowledge lifecycle">
                    <button type="button" onClick={() => onNavigate?.('lessons')}><Brain size={16} /><span><strong>{data?.counts.lesson ?? 0}</strong> lessons<small>Review evidence and promotion</small></span></button>
                    <button type="button" onClick={() => onNavigate?.('patterns')}><Sparkles size={16} /><span><strong>{data?.counts.pattern ?? 0}</strong> patterns<small>Conventions learned from code</small></span></button>
                    <button type="button" onClick={() => onNavigate?.('memory')}><Database size={16} /><span><strong>{data?.counts.memory ?? 0}</strong> memories<small>Stable facts agents can recall</small></span></button>
                    <button type="button" onClick={() => onNavigate?.('deep')}><ShieldCheck size={16} /><span><strong>{expertiseSignals.deepFindings}</strong> deep findings<small>Probabilistic insight with proof</small></span></button>
                    <button type="button" onClick={() => onNavigate?.('drift')}><GitBranch size={16} /><span><strong>{expertiseSignals.driftScans}</strong> scans<small>Drift: {expertiseSignals.driftDirection}</small></span></button>
                </div>
            )}
            {loading && <div className="graph-state"><RefreshCw className="spinning" size={22} /> Building the evidence map from local data…</div>}
            {error && <div className="graph-state error" role="alert"><AlertTriangle size={22} /><span>Graph unavailable: {error}</span><button type="button" onClick={load}>Retry</button></div>}
            {!loading && !error && renderData && (
                <>
                    <div className="graph-summary" aria-label="Graph legend">
                        {LEGEND_TYPES.filter(type => data?.counts[type]).map(type => <span key={type}><i className="node-swatch" style={{ background: NODE_COLORS[type] }} />{data?.counts[type]} {type}</span>)}
                        {data?.truncated && <span className="graph-limited"><AlertTriangle size={13} /> Focused for performance</span>}
                    </div>
                    <div className="graph-workspace">
                        <div className="graph-canvas-wrap">
                            {renderData.nodes.length > 0
                                ? <ImpactGraphCanvas data={renderData} selectedId={selection?.node.id ?? null} onSelect={setSelection} />
                                : <div className="graph-state"><Search size={20} />No connected evidence matches this view.</div>}
                            <div className="graph-instruction">Scroll to zoom · drag to explore · click to explain</div>
                        </div>
                        <Inspector selection={selection} />
                    </div>
                    <div className="graph-evidence-strip" aria-label="Recent governed work">
                        <div><strong>Recent governed work</strong><span>What Rigour observed—not inferred</span></div>
                        <ol>
                            {recentEvents.map(event => {
                                const label = event.tool || event.type || 'agent event';
                                return <li key={event.id} className={event.outcome}><i /><strong>{label.replace(/^rigour_/, '').replaceAll('_', ' ')}</strong><span>{event.summary || event.outcome}</span></li>;
                            })}
                            {recentEvents.length === 0 && <li className="empty"><i /><strong>No evidence yet</strong><span>Agent interactions will appear here.</span></li>}
                        </ol>
                    </div>
                </>
            )}
        </section>
    );
}
