import React from 'react';
import './ui.css';

export type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'plain';

/** A page's title, what it answers, and an optional action on the right. */
export const PageHeader: React.FC<{ title: string; lead?: React.ReactNode; aside?: React.ReactNode }> = ({ title, lead, aside }) => (
    <div className="ui-head">
        <div><h1>{title}</h1>{lead && <p>{lead}</p>}</div>
        {aside}
    </div>
);

export interface KpiItem { label: string; value: React.ReactNode; note?: React.ReactNode }

/** The few numbers a page leads with. A number Rigour has not recorded is shown as a dash with why, never as 0. */
export const Kpis: React.FC<{ items: KpiItem[] }> = ({ items }) => (
    <div className="ui-kpis">
        {items.map(item => (
            <div className="ui-kpi" key={item.label}>
                <span className="ui-label">{item.label}</span>
                <span className="ui-kpi-value">{item.value}</span>
                {item.note && <span className="ui-kpi-note">{item.note}</span>}
            </div>
        ))}
    </div>
);

export const Card: React.FC<{ title?: string; meta?: React.ReactNode; flush?: boolean; children: React.ReactNode }> = ({ title, meta, flush, children }) => (
    <section className="ui-card">
        {title && <div className="ui-card-head"><h2>{title}</h2>{meta && <span>{meta}</span>}</div>}
        {flush ? children : <div className="ui-card-body">{children}</div>}
    </section>
);

export const Chip: React.FC<{ tone?: Tone; children: React.ReactNode }> = ({ tone = 'plain', children }) => (
    <span className={`ui-chip ${tone === 'plain' ? '' : tone}`}>{children}</span>
);

/** What an empty section means, and how to fill it: never a bare "no data". */
export const Empty: React.FC<{ children: React.ReactNode }> = ({ children }) => <div className="ui-empty">{children}</div>;

export const Row: React.FC<{ label: React.ReactNode; value: React.ReactNode }> = ({ label, value }) => (
    <div className="ui-row"><span>{label}</span><span>{value}</span></div>
);

export const Meter: React.FC<{ share: number }> = ({ share }) => (
    <div className="ui-meter"><div style={{ width: `${Math.max(0, Math.min(1, share)) * 100}%` }} /></div>
);

export interface Column<T> { label: string; cell: (row: T) => React.ReactNode; wrap?: boolean }

export function Table<T>({ rows, columns, rowKey, onRow }: { rows: T[]; columns: Column<T>[]; rowKey: (row: T) => string; onRow?: (row: T) => void }) {
    return (
        <div className="ui-table-wrap">
            <table className="ui-table">
                <thead><tr>{columns.map(c => <th key={c.label}>{c.label}</th>)}</tr></thead>
                <tbody>
                    {rows.map(row => (
                        <tr key={rowKey(row)} className={onRow ? 'ui-clickable' : undefined} onClick={onRow ? () => onRow(row) : undefined}>
                            {columns.map(c => <td key={c.label} style={c.wrap ? undefined : { whiteSpace: 'nowrap' }}>{c.cell(row)}</td>)}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

export interface TimelineStep { key: string; title: string; when?: string; tone?: 'done' | 'ok' | 'bad' | 'todo'; children?: React.ReactNode }

export const Timeline: React.FC<{ steps: TimelineStep[] }> = ({ steps }) => (
    <div className="ui-timeline">
        {steps.map((step, i) => (
            <div className="ui-step" key={step.key}>
                <div className="ui-dot-col"><div className={`ui-dot ${step.tone && step.tone !== 'todo' ? step.tone : ''}`}>{i + 1}</div><div className="ui-line" /></div>
                <div className="ui-step-body">
                    <div className="ui-step-title"><strong>{step.title}</strong>{step.when && <span>{step.when}</span>}</div>
                    {step.children}
                </div>
            </div>
        ))}
    </div>
);

interface WeekBar { label: string; values: number[] }

/** Weeks side by side, one bar per series; colours follow `series`. */
export const WeekChart: React.FC<{ weeks: WeekBar[]; series: Array<{ label: string; color: string }> }> = ({ weeks, series }) => {
    const max = Math.max(1, ...weeks.flatMap(w => w.values));
    return (
        <div>
            <div className="ui-weeks" role="img" aria-label={weeks.map(w => `${w.label}: ${w.values.map((v, i) => `${v} ${series[i]?.label ?? ''}`).join(', ')}`).join('; ')}>
                {weeks.map(week => (
                    <div className="ui-week" key={week.label}>
                        <div className="ui-week-bars">
                            {week.values.map((v, i) => <span key={i} title={`${v} ${series[i]?.label ?? ''}`} style={{ height: `${(v / max) * 100}%`, background: series[i]?.color }} />)}
                        </div>
                        <small>{week.label}</small>
                    </div>
                ))}
            </div>
            <div className="ui-legend" style={{ marginTop: 10 }}>{series.map(s => <span key={s.label}><i style={{ background: s.color }} />{s.label}</span>)}</div>
        </div>
    );
};

export const Tabs: React.FC<{ tabs: Array<{ id: string; label: string }>; active: string; onChange: (id: string) => void }> = ({ tabs, active, onChange }) => (
    <div className="ui-tabs" role="tablist">
        {tabs.map(t => <button key={t.id} type="button" role="tab" aria-selected={t.id === active} className={t.id === active ? 'on' : ''} onClick={() => onChange(t.id)}>{t.label}</button>)}
    </div>
);
