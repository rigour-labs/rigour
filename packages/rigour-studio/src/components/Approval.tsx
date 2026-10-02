import React, { useEffect, useState } from 'react';
import { studioWrite } from '../studioWrite';
import './story.css';

export interface ApprovalRequest {
    requestId?: string;
    id?: string;
    command?: string;
    timestamp?: string;
    firewallDecision?: string;
    firewallReason?: string;
}

const WINDOW_S = 60;

/**
 * An agent asked to run a command that needs a person's yes (rigour_run). Opens as soon as the
 * request arrives; with no answer within a minute the agent's request is denied (fail-closed).
 */
export const Approval: React.FC<{ request: ApprovalRequest; onClose: () => void }> = ({ request, onClose }) => {
    const [left, setLeft] = useState(WINDOW_S);
    const [problem, setProblem] = useState<string | null>(null);
    useEffect(() => {
        const started = request.timestamp ? Date.parse(request.timestamp) : Date.now();
        const tick = () => setLeft(Math.max(0, WINDOW_S - Math.floor((Date.now() - started) / 1000)));
        tick();
        const id = window.setInterval(tick, 1000);
        return () => window.clearInterval(id);
    }, [request.timestamp]);

    const decide = async (decision: 'approve' | 'reject') => {
        const res = await studioWrite('/api/arbitrate', 'POST', JSON.stringify({ requestId: request.requestId || request.id, decision }));
        if (res.ok) onClose();
        else setProblem(res.status === 403 ? 'Studio was opened without the link from your terminal, or the request expired.' : `That didn't go through (HTTP ${res.status}).`);
    };

    return (
        <div role="dialog" aria-modal="true" aria-label="Approve a command" style={{ position: 'fixed', inset: 0, background: 'rgba(15, 17, 22, 0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 }}>
            <div className="st-card" style={{ width: 'min(560px, calc(100vw - 32px))', padding: 24 }}>
                <strong style={{ fontSize: 18 }}>Your agent wants to run a command</strong>
                <pre className="st-code st-mono" style={{ padding: '12px 14px', marginTop: 14, whiteSpace: 'pre-wrap' }}>{request.command}</pre>
                {request.firewallDecision && request.firewallDecision !== 'allow' && (
                    <div className="st-sub" style={{ marginTop: 10 }}>Rigour's pre-check: {request.firewallDecision}{request.firewallReason ? `: ${request.firewallReason}` : ''}</div>
                )}
                <div className="st-sub" style={{ marginTop: 10 }}>{left > 0 ? `Denied automatically in ${left}s if nobody answers.` : 'Time ran out: the request was denied.'}</div>
                {problem && <div className="st-sub" style={{ marginTop: 10, color: 'var(--status-error)' }}>{problem}</div>}
                <div className="st-row" style={{ marginTop: 18, justifyContent: 'flex-end' }}>
                    <button className="st-btn" onClick={onClose} type="button">Close</button>
                    <button className="st-btn" onClick={() => decide('reject')} type="button" disabled={left === 0}>Deny</button>
                    <button className="st-btn primary" onClick={() => decide('approve')} type="button" disabled={left === 0}>Allow</button>
                </div>
            </div>
        </div>
    );
};
