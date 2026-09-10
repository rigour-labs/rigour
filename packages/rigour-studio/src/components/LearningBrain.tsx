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

interface Lesson {
    id: string;
    subject: string;
    state: 'candidate' | 'validated' | 'promoted' | 'rejected' | 'superseded';
    visibility: 'personal' | 'team';
    source: string;
    actorId?: string;
    confidence: number;
    evidence?: Record<string, unknown>;
}

interface Props {
    onNavigate?: (tab: string) => void;
}

export function LearningBrain({ onNavigate }: Props) {
    const [data, setData] = useState<LearningPayload | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [lessons, setLessons] = useState<Lesson[]>([]);
    const [teamConfigured, setTeamConfigured] = useState(false);

    const load = async () => {
        setLoading(true);
        setError(null);
        try {
            const [overview, lessonResponse] = await Promise.all([fetch('/api/overview'), fetch('/api/lessons')]);
            if (!overview.ok) throw new Error(`HTTP ${overview.status}`);
            setData(await overview.json());
            if (lessonResponse.ok) {
                const payload = await lessonResponse.json();
                setLessons(payload.lessons ?? []);
                setTeamConfigured(payload.teamConfigured === true);
            }
        } catch (e: any) {
            setError(e.message || 'Failed to load learning signals');
        } finally {
            setLoading(false);
        }
    };

    const transition = async (id: string, state: Lesson['state']) => {
        const response = await fetch('/api/lessons', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, state }),
        });
        if (!response.ok) throw new Error(`Lesson update failed: HTTP ${response.status}`);
        await load();
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
                        <h3>Structural pattern index</h3>
                    </header>
                    <div className="learning-kpi">{data?.patternCount ?? 0}</div>
                    <p className="dim">
                        {data?.patternFiles ?? 0} files indexed automatically. Use <code>rigour index</code> for an
                        explicit rebuild after a large refactor.
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

            <section className="glass-card learning-lessons">
                <header><Brain size={16} className="text-purple" /><h3>Evidence-backed lessons</h3></header>
                <p className="dim">Interaction evidence is retained automatically. Only validated or explicitly published lessons can become reusable guidance.</p>
                {lessons.length === 0 ? <p className="dim">No interaction evidence recorded yet.</p> : (
                    <div className="lesson-list">
                        {lessons.slice(0, 20).map(lesson => (
                            <article className="lesson-row" key={lesson.id}>
                                <div>
                                    <strong>{lesson.subject}</strong>
                                    <small>{lesson.visibility} · {lesson.state} · owner {lesson.actorId || 'local user'} · confidence {Math.round(lesson.confidence * 100)}%</small>
                                    <small>Why: {lesson.source} evidence · {String(lesson.evidence?.outcome ?? 'recorded outcome')}</small>
                                </div>
                                <div className="lesson-actions">
                                    {lesson.state === 'candidate' && <button type="button" onClick={() => void transition(lesson.id, 'validated')}>Validate</button>}
                                    {!['rejected', 'superseded'].includes(lesson.state) && <button type="button" onClick={() => void transition(lesson.id, 'rejected')}>Reject</button>}
                                    {lesson.state === 'validated' && lesson.visibility === 'personal' && teamConfigured && <button type="button" onClick={() => void transition(lesson.id, 'promoted')}>Publish to team</button>}
                                </div>
                            </article>
                        ))}
                    </div>
                )}
                {!teamConfigured && lessons.some(lesson => lesson.state === 'validated' && lesson.visibility === 'personal') && (
                    <p className="dim">Configure PostgreSQL team mode in Settings before publishing personal learning to the team.</p>
                )}
            </section>
        </div>
    );
}
