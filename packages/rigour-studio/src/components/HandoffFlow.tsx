import React, { useEffect, useState } from 'react';
import { ArrowRight, ArrowRightLeft, CheckCircle2, Clock, Package, RefreshCw, Users } from 'lucide-react';

interface Handoff {
    handoffId: string;
    fromAgentId: string;
    toAgentId: string;
    taskDescription?: string;
    filesInScope?: string[];
    contextTokens?: number;
    status?: string;
    timestamp?: string;
    acceptedAt?: string;
}

export function HandoffFlow() {
    const [handoffs, setHandoffs] = useState<Handoff[]>([]);
    const [loading, setLoading] = useState(true);

    const load = async () => {
        setLoading(true);
        try {
            const res = await fetch('/api/handoffs');
            const data = await res.json();
            setHandoffs(Array.isArray(data.handoffs) ? data.handoffs : []);
        } catch (e) {
            console.error('Failed to load handoffs', e);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        load();
    }, []);

    if (!loading && handoffs.length === 0) {
        return (
            <div className="empty-state glass-card">
                <ArrowRightLeft size={48} />
                <h3>No Handoffs Yet</h3>
                <p>
                    Compress state with <code>rigour_checkpoint</code>, then transfer with{' '}
                    <code>rigour_handoff</code>. The receiving agent accepts via <code>rigour_handoff_accept</code>.
                </p>
                <div className="hint-box">
                    <span>Verified handoffs carry checkpoint packets — not parent transcripts.</span>
                </div>
            </div>
        );
    }

    return (
        <div className="handoff-flow">
            <div className="panel-header">
                <div className="title">
                    <ArrowRightLeft size={18} />
                    <span>Agent Handoffs</span>
                </div>
                <button type="button" className="icon-btn" onClick={load} aria-label="Refresh handoffs">
                    <RefreshCw size={14} className={loading ? 'spinning' : ''} />
                </button>
            </div>

            <div className="handoff-list">
                {handoffs.map((h) => {
                    const accepted = h.status === 'accepted' || Boolean(h.acceptedAt);
                    return (
                        <article key={h.handoffId} className={`handoff-card glass-card ${accepted ? 'accepted' : 'pending'}`}>
                            <div className="handoff-status">
                                {accepted ? (
                                    <span className="status-pill pass">
                                        <CheckCircle2 size={12} /> Accepted
                                    </span>
                                ) : (
                                    <span className="status-pill warn">
                                        <Clock size={12} /> Pending
                                    </span>
                                )}
                                <span className="mono dim">{h.handoffId}</span>
                            </div>

                            <div className="handoff-flow-row">
                                <div className="handoff-agent">
                                    <Users size={14} />
                                    <code>{h.fromAgentId}</code>
                                </div>
                                <ArrowRight size={16} className="text-cyan" />
                                <div className="handoff-packet">
                                    <Package size={14} />
                                    <span>{h.contextTokens != null ? `${h.contextTokens} tok` : 'packet'}</span>
                                </div>
                                <ArrowRight size={16} className="text-cyan" />
                                <div className="handoff-agent">
                                    <Users size={14} />
                                    <code>{h.toAgentId}</code>
                                </div>
                            </div>

                            {h.taskDescription && <p className="handoff-task">{h.taskDescription}</p>}

                            {h.filesInScope && h.filesInScope.length > 0 && (
                                <div className="handoff-files">
                                    {h.filesInScope.slice(0, 4).map((f) => (
                                        <code key={f}>{f}</code>
                                    ))}
                                    {h.filesInScope.length > 4 && (
                                        <span className="dim">+{h.filesInScope.length - 4} more</span>
                                    )}
                                </div>
                            )}
                        </article>
                    );
                })}
            </div>
        </div>
    );
}
