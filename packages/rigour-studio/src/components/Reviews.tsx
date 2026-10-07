import React from 'react';
import { ago, plural, useStudioJson } from './storyData';
import { BranchVerdict } from './Reviewer';
import './story.css';

interface PrePr {
    reviewed: { total: number; fixed: number; noIssue: number };
    recent: Array<{ file: string; function: string; verdict: string; reviewer: string; note: string; at: string }>;
    pending: Array<{ file: string; function: string; start: number; questions: string[] }>;
    spend: { runs: number; costUsd: number; unpricedRuns: number };
    lastModel?: string;
}

const WHO = (reviewer: string) => (reviewer === 'agent' ? 'your agent' : reviewer === 'human' ? 'you' : reviewer.replace(/^byok:/, ''));

/** "Review": everything that decides whether this branch is ready for a person: the reviewer's verdict first, then the risky functions your agent checked. */
export const Reviews: React.FC = () => {
    const { data, error } = useStudioJson<PrePr>('/api/pre-pr-review');
    if (error) return <div className="st-page"><div className="st-empty">Couldn't load reviews: {error}.</div></div>;
    if (!data) return <div className="st-page"><div className="st-sub">Loading…</div></div>;
    return (
        <div className="st-page">
            <h1 className="st-h1">Review before the PR</h1>
            <p className="st-lead">What still stands between this branch and a person's review: the reviewer's verdict, then the risky functions your agent checked.</p>

            <BranchVerdict />

            <h2 style={{ margin: '32px 0 6px', fontSize: 18, fontWeight: 600 }}>Risky functions your agent checks</h2>
            <p className="st-sub" style={{ margin: 0, lineHeight: 1.6 }}>
                Rigour picks the riskiest changed functions and asks specific questions about them. Your agent answers with its own model, or you do.
                {data.reviewed.total > 0 && ` So far: ${plural(data.reviewed.total, 'function')} reviewed, ${data.reviewed.fixed} fixed, ${data.reviewed.noIssue} with no issue.`}
            </p>

            <section style={{ marginTop: 24 }}>
                <h3 style={{ margin: '0 0 12px', fontSize: 15, fontWeight: 600 }}>Waiting</h3>
                {data.pending.length === 0
                    ? <div className="st-empty">No risky function in the current changes is waiting.</div>
                    : <div className="st-stack">{data.pending.map(p => (
                        <div className="st-card" key={`${p.file}:${p.function}`}>
                            <div className="st-row" style={{ justifyContent: 'space-between' }}><strong className="st-mono" style={{ fontSize: 14 }}>{p.function}</strong><span className="st-mono st-sub">{p.file}:{p.start}</span></div>
                            <ul style={{ margin: '10px 0 0', paddingLeft: 18, lineHeight: 1.6, fontSize: 14 }}>{p.questions.map(q => <li key={q}>{q}</li>)}</ul>
                        </div>
                    ))}</div>}
            </section>

            <section style={{ marginTop: 28 }}>
                <h3 style={{ margin: '0 0 12px', fontSize: 15, fontWeight: 600 }}>Checked</h3>
                {data.recent.length === 0
                    ? <div className="st-empty">Nothing reviewed yet. Agents review through rigour_review; you can run rigour review-task.</div>
                    : <div className="st-stack">{data.recent.map(r => (
                        <div className="st-card" key={`${r.file}:${r.function}:${r.at}`}>
                            <div className="st-row" style={{ justifyContent: 'space-between' }}>
                                <span><span className={`st-chip ${r.verdict === 'fixed' ? 'ok' : ''}`}>{r.verdict === 'fixed' ? 'fixed' : r.verdict === 'no_issue' ? 'no issue' : r.verdict}</span> <strong className="st-mono" style={{ fontSize: 14, marginLeft: 8 }}>{r.function}</strong></span>
                                <span className="st-sub">{WHO(r.reviewer)} · {ago(r.at)}</span>
                            </div>
                            <div className="st-mono st-sub" style={{ marginTop: 6 }}>{r.file}</div>
                            {r.note && <div style={{ marginTop: 10, fontSize: 14, lineHeight: 1.6 }}>{r.note}</div>}
                        </div>
                    ))}</div>}
            </section>

            <div className="st-sub" style={{ marginTop: 24 }}>
                Model reviews with your own key: {data.spend.runs === 0 ? 'none run here' : `${plural(data.spend.runs, 'run')}, ${spendText(data.spend)}${data.lastModel ? `, last with ${data.lastModel}` : ''}`}.
            </div>
        </div>
    );
};

/** Observed cost only; runs whose provider reported no price are said, not counted as free. */
function spendText(spend: PrePr['spend']): string {
    const priced = spend.runs - spend.unpricedRuns;
    if (priced === 0) return 'cost not reported by the provider';
    return `$${spend.costUsd.toFixed(2)} observed${spend.unpricedRuns ? ` (${spend.unpricedRuns} without a reported cost)` : ''}`;
}
