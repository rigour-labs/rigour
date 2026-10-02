import React from 'react';
import { ago, plural, useStudioJson, type CatchStage, type Story } from './storyData';
import './story.css';

interface WeekData { stories: Story[]; agentSaidDone: number; prCatches: number | null; stopped: { byStage: Record<CatchStage, number> } }

/**
 * "Only Rigour": what Rigour caught that the agent itself did not, counted only where it can be
 * shown. A head-to-head with other PR reviewers and bugs that reached main need PR history this
 * machine does not have; they say so instead of showing a number.
 */
export const OnlyRigour: React.FC = () => {
    const { data, error } = useStudioJson<WeekData>('/api/week');
    const setup = useStudioJson<{ checks: Array<{ id: string; state: string }> }>('/api/setup').data;
    const stopHookOn = setup?.checks.some(c => c.id === 'stop' && c.state !== 'missing' && c.state !== 'broken');
    if (error) return <div className="st-page"><div className="st-empty">Couldn't load: {error}.</div></div>;
    if (!data) return <div className="st-page"><div className="st-sub">Loading…</div></div>;
    const finishes = data.stories.filter(s => s.stage === 'stop');
    return (
        <div className="st-page">
            <h1 className="st-h1">What only Rigour caught</h1>
            <p className="st-lead">Counted only where Rigour can show it. A bug stopped before a PR never reached your other reviewers, so it is not counted against them.</p>

            <section style={{ marginTop: 28 }}>
                <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>Your agent tried to finish with a bug</h2>
                <p className="st-lead" style={{ fontSize: 14 }}>
                    {data.agentSaidDone === 0 && setup && !stopHookOn
                        ? 'The stop hook is not set up in this repository, so Rigour cannot see an agent finish. Run rigour setup.'
                        : data.agentSaidDone === 0
                        ? 'This week no agent tried to finish with a problem Rigour could prove.'
                        : `This week an agent tried to finish with a problem Rigour proved ${plural(data.agentSaidDone, 'time')}. Each was fixed before the agent stopped.`}
                </p>
                <div className="st-stack" style={{ marginTop: 14 }}>
                    {finishes.map(s => (
                        <div className="st-card st-row" key={s.id}>
                            <div style={{ flex: 1 }}>
                                <div style={{ fontSize: 15, lineHeight: 1.5 }}>{s.title}</div>
                                <div className="st-sub" style={{ marginTop: 4 }}><span className="st-mono">{s.file}</span> · {ago(s.at)}</div>
                            </div>
                            <span className="st-chip ok">fixed</span>
                        </div>
                    ))}
                </div>
            </section>

            <section style={{ marginTop: 32 }}>
                <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>Rigour and your other PR reviewers</h2>
                <div className="st-empty" style={{ marginTop: 14 }}>
                    {data.prCatches === null
                        ? 'No branch reviews recorded on this machine yet.'
                        : `Branch reviews here reported ${plural(data.prCatches, 'problem')} this week.`}
                    {' '}Side by side with teammates and review bots (both caught it, only Rigour, only them) needs the PR's review comments; it comes with the PR integration.
                </div>
            </section>
        </div>
    );
};
