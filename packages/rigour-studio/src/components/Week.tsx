import React, { useState } from 'react';
import { studioWrite } from '../studioWrite';
import { ago, plural, STAGE_WORDS, useStudioJson, type CatchStage, type Story, inlineCode } from './storyData';
import './story.css';

interface Need { key?: string; file: string; rule: string; title: string; openedAt: string; stage?: CatchStage }
interface WeekData {
    recordingSince: string | null;
    needs: Need[];
    stories: Story[];
    stopped: { total: number; byStage: Record<CatchStage, number> };
    agentSaidDone: number;
    raised: number;
    overruled: number;
}

const INTRO_KEY = 'rigour-intro-hidden';

/** "This week": what needs you, then what Rigour stopped, as stories a person can read. */
export const Week: React.FC<{ onNavigate: (tab: string) => void }> = ({ onNavigate }) => {
    const { data, error, reload } = useStudioJson<WeekData>('/api/week');
    const [open, setOpen] = useState<string | null>(null);
    const [intro, setIntro] = useState(() => { try { return localStorage.getItem(INTRO_KEY) !== '1'; } catch { return true; } });
    if (error) return <div className="st-page"><div className="st-empty">Couldn't load this week: {error}.</div></div>;
    if (!data) return <div className="st-page"><div className="st-sub">Loading…</div></div>;

    const hideIntro = () => { try { localStorage.setItem(INTRO_KEY, '1'); } catch { /* not remembered */ } setIntro(false); };
    const needs = data.needs;
    return (
        <div className="st-page">
            {intro && <HowItWorks onHide={hideIntro} />}
            <h1 className="st-h1">{needs.length === 0 ? 'Nothing needs you.' : `${plural(needs.length, 'thing needs', 'things need')} you.`}</h1>
            <p className="st-lead">
                {data.stopped.total > 0
                    ? `${plural(data.stopped.total, 'problem')} stopped and fixed before a pull request this week.`
                    : data.recordingSince ? 'Nothing was stopped this week.' : 'Rigour has not recorded any agent work in this repository yet.'}
            </p>
            {needs.length > 0 && <Recheck onDone={reload} />}
            {needs.length > 0 && <div className="st-stack" style={{ marginTop: 18 }}>{needs.map(n => <NeedCard key={`${n.rule}:${n.file}`} need={n} onDone={reload} />)}</div>}
            <div className="st-grid">
                <section>
                    <h2 style={{ margin: '0 0 14px', fontSize: 18, fontWeight: 600 }}>What Rigour stopped this week</h2>
                    {data.stories.length === 0
                        ? <div className="st-empty">When an agent fixes something Rigour caught, it appears here with the code change.</div>
                        : <div className="st-stack">{data.stories.map(s => <StoryCard key={s.id} story={s} open={open === s.id} onToggle={() => setOpen(open === s.id ? null : s.id)} />)}</div>}
                </section>
                <aside className="st-side">
                    <div className="st-card">
                        <div className="st-big">{data.stopped.total}</div>
                        <div style={{ fontSize: 14, marginTop: 6 }}>stopped before a PR</div>
                        <div className="st-sub" style={{ marginTop: 10, lineHeight: 1.6 }}>
                            {data.stopped.byStage.edit} while writing · {data.stopped.byStage.review} on review · {data.stopped.byStage.stop} before done
                        </div>
                        <CopySummary data={data} />
                    </div>
                    <div className="st-card">
                        <div style={{ fontSize: 15, fontWeight: 600 }}>Is it noisy?</div>
                        <div style={{ fontSize: 14, marginTop: 8, lineHeight: 1.6 }}>
                            {data.raised === 0 ? 'Nothing raised this week.' : `Rigour raised ${plural(data.raised, 'problem')} this week. You overruled ${data.overruled}.`}
                        </div>
                        <div className="st-sub" style={{ marginTop: 8, lineHeight: 1.6 }}>Say "not a bug" once and Rigour stops raising it.</div>
                    </div>
                    <button className="st-btn" onClick={() => onNavigate('learns')} type="button">See how it learns</button>
                    {data.recordingSince && <div className="st-sub">Recording since {new Date(data.recordingSince).toLocaleDateString()}</div>}
                </aside>
            </div>
        </div>
    );
};

const HowItWorks: React.FC<{ onHide: () => void }> = ({ onHide }) => (
    <section className="st-card" style={{ marginBottom: 28 }}>
        <div className="st-row" style={{ justifyContent: 'space-between', marginBottom: 16 }}>
            <strong>How Rigour works</strong>
            <button className="st-btn" onClick={onHide} type="button">Got it</button>
        </div>
        <div className="st-steps">
            <div className="st-step"><span className="st-num">1</span><div>Your AI agent writes code<div className="st-sub">Claude Code, Cursor, any agent.</div></div></div>
            <div className="st-step"><span className="st-num">2</span><div>Rigour checks every change<div className="st-sub">It stops the agent only on problems it can prove; the agent fixes them.</div></div></div>
            <div className="st-step"><span className="st-num">3</span><div>Your PR arrives clean<div className="st-sub">A short PR review catches the rest. Every fix teaches Rigour your code.</div></div></div>
        </div>
    </section>
);

/** Checks every open finding again against the code as it is now: what the checks no longer report closes, never as a fix. */
const Recheck: React.FC<{ onDone: () => void }> = ({ onDone }) => {
    const [said, setSaid] = useState<string | null>(null);
    const recheck = async () => {
        const res = await studioWrite('/api/recheck', 'POST', '{}');
        if (!res.ok) return setSaid('Could not check again.');
        const { closed } = await res.json() as { closed: number };
        setSaid(closed ? `${plural(closed, 'finding')} no longer reported, closed (not counted as fixes).` : 'Every one is still reported.');
        onDone();
    };
    return <div className="st-row" style={{ marginTop: 10, gap: 12 }}><button className="st-btn" onClick={recheck} type="button">Check these again</button>{said && <span className="st-sub">{said}</span>}</div>;
};

export const NeedCard: React.FC<{ need: Need; onDone: () => void }> = ({ need, onDone }) => {
    const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
    const dismiss = async () => {
        const reason = window.prompt('Why is this not a bug? Rigour keeps the reason with the dismissal.');
        if (!reason?.trim() || !need.key) return;
        const res = await studioWrite('/api/dismiss', 'POST', JSON.stringify({ key: need.key, reason }));
        if (res.ok) onDone(); else setState('failed');
    };
    const copy = async () => {
        try {
            await navigator.clipboard.writeText(`Rigour found a problem you introduced: ${need.title} in ${need.file}. Fix it, then run rigour review.`);
            setState('copied');
        } catch { setState('failed'); }
    };
    return (
        <div className="st-need">
            <div className="st-row"><span className="st-chip warn">open</span><span className="st-sub">found {need.stage ? STAGE_WORDS[need.stage] : ''} · {ago(need.openedAt)}</span></div>
            <div style={{ fontSize: 17, marginTop: 10, lineHeight: 1.5 }}>{need.title}</div>
            <div className="st-mono st-sub" style={{ marginTop: 6 }}>{need.file}</div>
            <div className="st-row" style={{ marginTop: 14, flexWrap: 'wrap' }}>
                <button className="st-btn primary" onClick={copy} type="button">{state === 'copied' ? 'Copied: paste it to your agent' : 'Copy for my agent'}</button>
                {need.key && <button className="st-btn" onClick={dismiss} type="button">It's fine, not a bug</button>}
                {state === 'failed' && <span className="st-sub">That didn't work. Open Studio from the link in your terminal and try again.</span>}
            </div>
        </div>
    );
};

export const StoryCard: React.FC<{ story: Story; open: boolean; onToggle: () => void }> = ({ story, open, onToggle }) => (
    <div>
        <button className="st-story" onClick={onToggle} type="button" aria-expanded={open}>
            <div className="st-row" style={{ justifyContent: 'space-between' }}><span className="st-chip">{STAGE_WORDS[story.stage]}</span><span className="st-sub">{ago(story.at)}</span></div>
            <div style={{ fontSize: 16, lineHeight: 1.55, marginTop: 10 }}>{inlineCode(story.title)}</div>
            <div className="st-sub" style={{ marginTop: 6 }}><span className="st-mono">{story.file}</span> · fixed by the agent</div>
        </button>
        {open && (
            <div className="st-story-body">
                {story.diff.length > 0 && (
                    <div className="st-code st-mono">
                        {story.diff.map((line, i) => <span key={i} className={`st-ln ${line[0] === '+' ? 'add' : line[0] === '-' ? 'del' : ''}`}>{line}</span>)}
                    </div>
                )}
                {story.details && story.details !== story.title && (
                    <div style={{ marginTop: story.diff.length ? 16 : 0 }}>
                        <strong style={{ fontSize: 13 }}>{story.stage === 'review' && story.rule === 'review' ? 'What the agent fixed' : 'How Rigour knew'}</strong>
                        <div className="st-sub" style={{ marginTop: 6, lineHeight: 1.6 }}>{inlineCode(story.details)}</div>
                    </div>
                )}
            </div>
        )}
    </div>
);

const CopySummary: React.FC<{ data: WeekData }> = ({ data }) => {
    const [copied, setCopied] = useState(false);
    if (data.stopped.total === 0) return null;
    const text = `Rigour stopped ${plural(data.stopped.total, 'problem')} before a pull request this week: `
        + `${data.stopped.byStage.edit} while the agent was writing, ${data.stopped.byStage.review} when it checked its work, ${data.stopped.byStage.stop} before it said done. `
        + `${data.overruled} of ${data.raised} overruled.`;
    const copy = async () => { try { await navigator.clipboard.writeText(text); setCopied(true); } catch { /* clipboard blocked */ } };
    return <button className="st-btn" onClick={copy} type="button" style={{ marginTop: 14, width: '100%' }}>{copied ? 'Copied' : 'Copy this week'}</button>;
};
