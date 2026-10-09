import React, { useState } from 'react';
import { plural, useStudioJson, inlineCode } from './storyData';
import './story.css';

type Kind = 'stopped' | 'reported' | 'fixed' | 'checked' | 'reviewed' | 'taught' | 'pr';
interface Item { at: string; kind: Kind; text: string; detail?: string }
interface Session {
    start: string;
    end: string;
    counts: Record<Kind, number> & { reviewedFixed: number };
    highlights: Item[];
    rest: Item[];
}

const CHIP: Record<Kind, { label: string; cls: string }> = {
    stopped: { label: 'blocked', cls: 'warn' },
    reported: { label: 'reported', cls: 'warn' },
    fixed: { label: 'fixed', cls: 'ok' },
    checked: { label: 'checked', cls: '' },
    reviewed: { label: 'reviewed', cls: '' },
    taught: { label: 'told', cls: '' },
    pr: { label: 'PR', cls: 'warn' },
};

const time = (at: string) => new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const day = (at: string) => new Date(at).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });

/** "Activity": agent sessions, newest first. Each says what mattered; the routine rest folds away. */
export const Activity: React.FC = () => {
    const { data, error } = useStudioJson<{ sessions: Session[] }>('/api/activity');
    if (error) return <div className="st-page"><div className="st-empty">Couldn't load activity: {error}.</div></div>;
    if (!data) return <div className="st-page"><div className="st-sub">Loading…</div></div>;
    return (
        <div className="st-page">
            <h1 className="st-h1">Activity</h1>
            <p className="st-lead">Each block is one stretch of agent work. What Rigour blocked, reported or got fixed is listed; routine checks fold away.</p>
            {data.sessions.length === 0
                ? <div className="st-empty" style={{ marginTop: 24 }}>Nothing yet. Activity appears as agents edit code, ask for reviews and finish their work.</div>
                : <div className="st-stack" style={{ marginTop: 24, gap: 16 }}>{data.sessions.map(s => <SessionCard key={s.start} session={s} />)}</div>}
        </div>
    );
};

export const SessionCard: React.FC<{ session: Session }> = ({ session }) => {
    const [open, setOpen] = useState(false);
    const c = session.counts;
    const fixed = c.fixed + c.reviewedFixed;
    const summary = [
        fixed && `${plural(fixed, 'problem')} fixed`,
        c.stopped && `${plural(c.stopped, 'edit')} blocked`,
        c.reported && `${plural(c.reported, 'edit')} reported on`,
        c.pr && `${plural(c.pr, 'branch review')} with findings`,
        c.reviewed && `${plural(c.reviewed, 'risky function')} reviewed${c.reviewed - c.reviewedFixed ? ` (${c.reviewed - c.reviewedFixed} fine)` : ''}`,
        c.checked && `${plural(c.checked, 'edit')} checked clean`,
        c.taught && `lessons given ${plural(c.taught, 'time')}`,
    ].filter(Boolean).join(' · ');
    return (
        <section className="st-card" style={{ padding: 0 }}>
            <div style={{ padding: '16px 20px', borderBottom: session.highlights.length || open ? '1px solid var(--border-dim)' : 0 }}>
                <div className="st-row" style={{ justifyContent: 'space-between' }}>
                    <strong>{day(session.start)}, {time(session.start)}{session.start !== session.end ? `–${time(session.end)}` : ''}</strong>
                    {session.rest.length > 0 && (
                        <button className="st-btn" onClick={() => setOpen(!open)} type="button" style={{ minHeight: 32 }}>{open ? 'Hide routine' : `Show ${plural(session.rest.length, 'routine item')}`}</button>
                    )}
                </div>
                <div className="st-sub" style={{ marginTop: 6 }}>{summary}</div>
            </div>
            {[...session.highlights, ...(open ? session.rest : [])].map((item, i) => (
                <div key={`${item.at}-${i}`} className="st-row" style={{ padding: '12px 20px', borderTop: i ? '1px solid var(--border-dim)' : 0, alignItems: 'flex-start' }}>
                    <span className={`st-chip ${item.kind === 'reviewed' && item.text.startsWith('Fixed ') ? 'ok' : CHIP[item.kind].cls}`} style={{ minWidth: 70, textAlign: 'center' }}>
                        {item.kind === 'reviewed' && item.text.startsWith('Fixed ') ? 'fixed' : CHIP[item.kind].label}
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 14, lineHeight: 1.5 }}>{inlineCode(item.text)}</div>
                        {item.detail && <div className="st-sub" style={{ marginTop: 3, lineHeight: 1.5 }}>{item.detail}</div>}
                    </div>
                    <span className="st-sub" style={{ whiteSpace: 'nowrap' }}>{time(item.at)}</span>
                </div>
            ))}
        </section>
    );
};
