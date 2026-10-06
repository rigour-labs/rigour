import React from 'react';
import { useStudioJson } from './storyData';
import { ReviewerSetup } from './Reviewer';
import './story.css';

interface SetupCheck { id: string; name: string; state: 'working' | 'set up' | 'broken' | 'missing'; detail: string; fix?: string }

const CHIP: Record<SetupCheck['state'], string> = { working: 'ok', 'set up': '', broken: 'bad', missing: 'warn' };

/** "Setup": the same checks as `rigour doctor`: wired up, and seen firing this week. */
export const SetupView: React.FC = () => {
    const { data, error } = useStudioJson<{ checks: SetupCheck[] }>('/api/setup');
    if (error) return <div className="st-page"><div className="st-empty">Couldn't check setup: {error}.</div></div>;
    if (!data) return <div className="st-page"><div className="st-sub">Checking…</div></div>;
    return (
        <div className="st-page">
            <h1 className="st-h1">Setup</h1>
            <p className="st-lead">What runs in this repository, and whether Rigour saw it work this week. The same checks run with <span className="st-mono">rigour doctor</span>.</p>
            <div className="st-stack" style={{ marginTop: 24 }}>
                {data.checks.map(c => (
                    <div className="st-card st-row" key={c.id}>
                        <span className={`st-chip ${CHIP[c.state]}`} style={{ minWidth: 72, textAlign: 'center' }}>{c.state}</span>
                        <div style={{ flex: 1 }}>
                            <div style={{ fontSize: 15 }}>{c.name}</div>
                            <div className="st-sub" style={{ marginTop: 4 }}>{c.detail}</div>
                        </div>
                        {c.fix && c.state !== 'working' && <span className="st-mono st-sub">{c.fix}</span>}
                    </div>
                ))}
            </div>
            <ReviewerSetup />
            <h2 style={{ margin: '32px 0 6px', fontSize: 18, fontWeight: 600 }}>Who double-checks risky code</h2>
            <div className="st-grid" style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', marginTop: 12 }}>
                <div className="st-card">
                    <div className="st-row" style={{ justifyContent: 'space-between' }}><strong>Your agent's own model</strong><span>Free</span></div>
                    <div className="st-sub" style={{ marginTop: 8, lineHeight: 1.6 }}>Your agent calls <span className="st-mono">rigour_review</span> and answers Rigour's questions with the model you already pay for. No key.</div>
                </div>
                <div className="st-card">
                    <div className="st-row" style={{ justifyContent: 'space-between' }}><strong>Your own API key</strong><span>Pay per use</span></div>
                    <div className="st-sub" style={{ marginTop: 8, lineHeight: 1.6 }}>For code written without an agent, and for PR reviews. <span className="st-mono">rigour settings set-key</span>; keys are never shown here.</div>
                </div>
            </div>
        </div>
    );
};
