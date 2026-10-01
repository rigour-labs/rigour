import React, { useEffect, useState } from 'react';
import { CheckCircle, Clock, Wrench } from 'lucide-react';

export interface PrePrReviewData {
    reviewed: { total: number; fixed: number; noIssue: number; byReviewer: Record<string, number> };
    recent: Array<{ file: string; function: string; verdict: 'fixed' | 'no_issue'; reviewer: string; note: string; at: string }>;
    pending: Array<{ file: string; function: string; start: number; questions: string[] }>;
    spend: {
        runs: number; costUsd: number; unpricedRuns: number; inputTokens: number; outputTokens: number;
        functionsRanked: number; functionsRouted: number; alreadyReviewed: number; toolCalls: number;
    };
    lastModel?: string;
}

export function formatUsd(value: number): string {
    return value < 1 ? `$${value.toFixed(3)}` : `$${value.toFixed(2)}`;
}

/** Share of ranked functions the router kept away from the model, as a whole percentage. */
export function routerSaving(spend: PrePrReviewData['spend']): number | null {
    if (spend.functionsRanked === 0) return null;
    return Math.round(100 * (1 - spend.functionsRouted / spend.functionsRanked));
}

export function PrePrReviewView({ data }: { data: PrePrReviewData }) {
    const { reviewed, recent, pending, spend } = data;
    const saving = routerSaving(spend);
    return <section className="studio-settings-view">
        <header className="page-intro">
            <span>Before the PR</span>
            <h1>Reviewed while the code was written</h1>
            <p>Risky changed functions your agent (or you) reviewed before a pull request existed, what is still waiting, and what model review actually cost.</p>
        </header>
        <div className="cost-kpi-grid">
            <div className="cost-kpi-card glass-card">
                <div className="label">Reviewed before the PR</div>
                <div className="value">{reviewed.total}</div>
                <div className="meta">{Object.entries(reviewed.byReviewer).map(([who, n]) => `${who} ${n}`).join(' · ') || 'none yet'}</div>
            </div>
            <div className="cost-kpi-card glass-card">
                <div className="label">Defects fixed before the PR</div>
                <div className="value text-emerald">{reviewed.fixed}</div>
                <div className="meta">{reviewed.noIssue} checked with no issue</div>
            </div>
            <div className="cost-kpi-card glass-card">
                <div className="label">Waiting for review</div>
                <div className={`value ${pending.length ? 'text-amber' : ''}`}>{pending.length}</div>
                <div className="meta">risky functions in uncommitted work</div>
            </div>
            <div className="cost-kpi-card glass-card">
                <div className="label">Model review spend</div>
                <div className="value">{formatUsd(spend.costUsd)}</div>
                <div className="meta">
                    observed over {spend.runs} run(s){spend.unpricedRuns ? ` · ${spend.unpricedRuns} unpriced` : ''}
                    {saving !== null ? ` · router skipped ${saving}% of changed functions` : ''}
                    {spend.alreadyReviewed ? ` · ${spend.alreadyReviewed} already reviewed` : ''}
                </div>
            </div>
        </div>
        {pending.length > 0 && <div className="settings-card">
            {pending.map(item => <div className="setting-row" key={`${item.file}:${item.function}`}>
                <Clock size={18} aria-hidden="true" />
                <div><strong>{item.file}:{item.start} · {item.function}</strong><span>{item.questions[0]}</span></div>
                <em className="waiting">Waiting</em>
            </div>)}
        </div>}
        {recent.length > 0 && <div className="settings-card">
            {recent.map(entry => <div className="setting-row" key={`${entry.file}:${entry.function}:${entry.at}`}>
                {entry.verdict === 'fixed' ? <Wrench size={18} aria-hidden="true" /> : <CheckCircle size={18} aria-hidden="true" />}
                <div><strong>{entry.file} · {entry.function}</strong><span>{entry.note}</span></div>
                <em>{entry.verdict === 'fixed' ? 'Fixed' : 'No issue'} · {entry.reviewer}</em>
            </div>)}
        </div>}
        {data.lastModel && <div className="settings-command"><span>Last review model</span><code>{data.lastModel}</code></div>}
        {reviewed.total === 0 && pending.length === 0 && <div className="settings-command"><span>Start</span><code>rigour review-task</code></div>}
    </section>;
}

export function PrePrReview() {
    const [data, setData] = useState<PrePrReviewData | null>(null);
    const [error, setError] = useState<string | null>(null);
    useEffect(() => {
        fetch('/api/pre-pr-review')
            .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
            .then(setData)
            .catch((e: Error) => setError(e.message));
    }, []);
    if (error) return <div className="overview-banner warn" role="alert"><div><strong>Pre-PR review unavailable</strong><p>{error}</p></div></div>;
    if (!data) return <div className="overview-banner"><div><strong>Loading pre-PR review</strong></div></div>;
    return <PrePrReviewView data={data} />;
}
