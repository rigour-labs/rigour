import React from 'react';
import { ago, plural, useStudioJson } from './storyData';
import './story.css';

interface ContextData {
    week: {
        scopes: number;
        filesConsidered: number;
        filesReturned: number;
        tokensConsidered: number;
        tokensReturned: number;
        recalls: number;
        lessonsTold: number;
        reuse: Array<{ at: string; planned: string; existing: string; action: string }>;
    };
    weeks: Array<{ from: string; scopes: number; filesReturned: number; filesConsidered: number; recalls: number; lessonsTold: number; reuse: number }>;
}

const thousands = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

/** "Agent context": what Rigour gave agents before they wrote, so fewer mistakes need catching. */
export const AgentContext: React.FC = () => {
    const { data, error } = useStudioJson<ContextData>('/api/context');
    if (error) return <div className="st-page"><div className="st-empty">Couldn't load agent context: {error}.</div></div>;
    if (!data) return <div className="st-page"><div className="st-sub">Loading…</div></div>;
    const w = data.week;
    const nothing = w.scopes + w.recalls + w.lessonsTold + w.reuse.length === 0;
    return (
        <div className="st-page">
            <h1 className="st-h1">What Rigour gave your agents</h1>
            <p className="st-lead">Before an agent writes, it can ask Rigour where to look, what this team already knows, and whether the thing it is about to write exists. Preventing a mistake is cheaper than catching it.</p>

            {nothing ? (
                <div className="st-empty" style={{ marginTop: 24 }}>No agent asked Rigour for context this week. Agents use it through the Rigour tools (rigour_context_scope, rigour_recall, rigour_check_pattern); Setup shows whether they are connected.</div>
            ) : (
                <div className="st-grid" style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }}>
                    <Fact
                        title="Where to look"
                        value={w.scopes === 0 ? 'Not asked this week' : `${plural(w.filesReturned, 'file')} instead of ${w.filesConsidered}`}
                        detail={w.scopes === 0 ? 'Agents can ask for the files a task needs instead of reading broadly.' : `${plural(w.scopes, 'request')}. About ${thousands(w.tokensReturned)} tokens returned out of ${thousands(w.tokensConsidered)} considered (Rigour's estimate).`}
                    />
                    <Fact
                        title="What this team knows"
                        value={`${plural(w.lessonsTold, 'lesson')} told`}
                        detail={`${plural(w.recalls, 'recall')} of saved facts and lessons. How it learns shows what each lesson stopped.`}
                    />
                    <section className="st-card" style={{ gridColumn: '1 / -1' }}>
                        <strong>Pointed to code that already exists</strong>
                        {w.reuse.length === 0
                            ? <div className="st-sub" style={{ marginTop: 8, lineHeight: 1.6 }}>No duplicate was about to be written this week.</div>
                            : <div className="st-stack" style={{ marginTop: 12 }}>{w.reuse.map(r => (
                                <div className="st-row" key={`${r.at}-${r.planned}`} style={{ alignItems: 'flex-start' }}>
                                    <span className={`st-chip ${r.action === 'BLOCK' ? 'warn' : ''}`}>{r.action === 'BLOCK' ? 'reuse' : 'similar'}</span>
                                    <div style={{ flex: 1, fontSize: 14, lineHeight: 1.5 }}>
                                        About to write <span className="st-mono">{r.planned}</span>; told to use <span className="st-mono">{r.existing}</span>
                                    </div>
                                    <span className="st-sub">{ago(r.at)}</span>
                                </div>
                            ))}</div>}
                    </section>
                </div>
            )}

            <WeeklyTable weeks={data.weeks} />
        </div>
    );
};

const Fact: React.FC<{ title: string; value: string; detail: string }> = ({ title, value, detail }) => (
    <section className="st-card">
        <div className="st-sub">{title}</div>
        <div style={{ fontSize: 22, fontWeight: 600, marginTop: 6, color: 'var(--text-primary)' }}>{value}</div>
        <div className="st-sub" style={{ marginTop: 8, lineHeight: 1.6 }}>{detail}</div>
    </section>
);

/** One row per week that had any context activity; quiet weeks are left out rather than shown as rows of zeros. */
export const WeeklyTable: React.FC<{ weeks: ContextData['weeks'] }> = ({ weeks }) => {
    const active = weeks.filter(w => w.scopes + w.recalls + w.lessonsTold + w.reuse > 0).reverse();
    return (
        <section className="st-card" style={{ marginTop: 24, padding: 0, overflowX: 'auto' }}>
            <div style={{ padding: '16px 20px 8px' }}><strong>Last 8 weeks</strong></div>
            {active.length === 0
                ? <div className="st-sub" style={{ padding: '0 20px 18px' }}>No context requests in the last 8 weeks.</div>
                : (
                    <table className="st-table">
                        <thead>
                            <tr><th>Week of</th><th>Focused file lists</th><th>Files given</th><th>Recalls</th><th>Lessons told</th><th>Duplicates avoided</th></tr>
                        </thead>
                        <tbody>
                            {active.map(w => (
                                <tr key={w.from}>
                                    <td>{new Date(w.from).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</td>
                                    <td>{w.scopes}</td>
                                    <td>{w.scopes ? `${w.filesReturned} of ${w.filesConsidered}` : '—'}</td>
                                    <td>{w.recalls}</td>
                                    <td>{w.lessonsTold}</td>
                                    <td>{w.reuse}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
        </section>
    );
};
