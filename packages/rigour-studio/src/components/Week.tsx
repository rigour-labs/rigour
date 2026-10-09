import React, { useState } from 'react';
import { studioWrite } from '../studioWrite';
import { HowItWorks } from './HowItWorks';
import { groupNeeds, NeedGroupCard, needsHeading, type OpenNeed } from './NeedGroups';
import { ago, plural, STAGE_WORDS, useStudioJson, type CatchStage, type Story, inlineCode } from './storyData';
import './story.css';

interface WeekData {
    recordingSince: string | null;
    needs: OpenNeed[];
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
    const groups = groupNeeds(needs);
    return (
        <div className="st-page">
            {intro && <HowItWorks onHide={hideIntro} />}
            <h1 className="st-h1">{needsHeading(groups)}</h1>
            <p className="st-lead">
                {data.stopped.total > 0
                    ? `${plural(data.stopped.total, 'problem')} stopped and fixed before a pull request this week.`
                    : data.recordingSince ? 'Nothing was stopped this week.' : 'Rigour has not recorded any agent work in this repository yet.'}
            </p>
            {needs.length > 0 && <Recheck onDone={reload} />}
            {groups.length > 0 && <div className="st-stack" style={{ marginTop: 18 }}>{groups.map(g => <NeedGroupCard key={`${g.rule}:${g.pattern}`} group={g} onDone={reload} />)}</div>}
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

/** Checks every open finding again against the code as it is now: what the checks no longer report closes, never as a fix. */
const Recheck: React.FC<{ onDone: () => void }> = ({ onDone }) => {
    const [said, setSaid] = useState<string | null>(null);
    const recheck = async () => {
        const res = await studioWrite('/api/recheck', 'POST', '{}');
        if (!res.ok) return setSaid('Could not check again.');
        const { closed, fixed } = await res.json() as { closed: number; fixed: number };
        const said = [fixed ? `${plural(fixed, 'fix')} by the agent recorded` : '', closed ? `${plural(closed, 'finding')} no longer reported, closed (not counted as fixes)` : ''].filter(Boolean).join('; ');
        setSaid(said ? `${said}.` : 'Every one is still reported.');
        onDone();
    };
    return <div className="st-row" style={{ marginTop: 10, gap: 12 }}><button className="st-btn" onClick={recheck} type="button">Check these again</button>{said && <span className="st-sub">{said}</span>}</div>;
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
