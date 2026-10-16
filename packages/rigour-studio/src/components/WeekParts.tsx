import React, { useState } from 'react';
import { studioWrite } from '../studioWrite';
import { Card, Chip, Empty, WeekChart } from './ui';
import { outcomeWords, type PullRow, type PullsList } from './pullsData';
import { ago, inlineCode, plural, STAGE_WORDS, useStudioJson, type CatchStage, type Story } from './storyData';

export interface WeekData {
    recordingSince: string | null;
    needs: Array<{ key?: string; file: string; rule: string; title: string; openedAt: string; stage?: CatchStage }>;
    stories: Story[];
    stopped: { total: number; fixed: number; byStage: Record<CatchStage, number> };
    agentSaidDone: number;
    raised: number;
    overruled: number;
    /** Model reviews run this week; null when none was ever recorded (older Studio servers send nothing). */
    reviews?: number | null;
}

export interface ProgressWeek { from: string; repeatsStopped: number; repeatsReachedPr: number | null }

/** Checks every open finding again against the code as it is now: what the checks no longer report closes, never as a fix. */
export const Recheck: React.FC<{ onDone: () => void }> = ({ onDone }) => {
    const [said, setSaid] = useState<string | null>(null);
    const recheck = async () => {
        const res = await studioWrite('/api/recheck', 'POST', '{}');
        if (!res.ok) return setSaid('Could not check again.');
        const { closed, fixed } = await res.json() as { closed: number; fixed: number };
        const said = [fixed ? `${plural(fixed, 'fix')} by the agent recorded` : '', closed ? `${plural(closed, 'finding')} no longer reported, closed (not counted as fixes)` : ''].filter(Boolean).join('; ');
        setSaid(said ? `${said}.` : 'Every one is still reported.');
        onDone();
    };
    return <div className="week-actions"><button className="st-btn" onClick={recheck} type="button">Check these again</button>{said && <span className="st-sub">{said}</span>}</div>;
};

export const StoryCard: React.FC<{ story: Story; open: boolean; onToggle: () => void }> = ({ story, open, onToggle }) => (
    <div>
        <button className="st-story" onClick={onToggle} type="button" aria-expanded={open}>
            <div className="st-row" style={{ justifyContent: 'space-between' }}><span className="st-chip">{STAGE_WORDS[story.stage]}</span><span className="st-sub">{ago(story.at)}</span></div>
            <div className={open ? 'st-story-title' : 'st-story-title clamped'}>{inlineCode(story.title)}</div>
            <div className="st-sub st-story-file" title={story.file}><span className="st-mono">{story.file}</span> · fixed by the agent</div>
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

function summaryText(data: WeekData): string {
    return `Rigour stopped ${plural(data.stopped.total, 'problem')} before a pull request this week: `
        + `${data.stopped.byStage.edit} while the agent was writing, ${data.stopped.byStage.review} when it checked its work, ${data.stopped.byStage.stop} before it said done. `
        + `${data.stopped.fixed} fixed so far. `
        + `${data.overruled} of ${data.raised} overruled.`;
}

export const CopySummary: React.FC<{ data: WeekData }> = ({ data }) => {
    const [copied, setCopied] = useState(false);
    if (data.stopped.total === 0) return null;
    const copy = async () => { try { await navigator.clipboard.writeText(summaryText(data)); setCopied(true); } catch { /* clipboard blocked */ } };
    return <button className="st-btn" onClick={copy} type="button">{copied ? 'Copied' : 'Copy this week'}</button>;
};

/** Eight weeks of repeat mistakes: caught while an agent wrote, against those that still reached a pull request. */
export const RepeatsChart: React.FC<{ weeks: ProgressWeek[] }> = ({ weeks }) => {
    const prKnown = weeks.some(w => w.repeatsReachedPr !== null);
    const label = (from: string) => new Date(from).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    const series = [{ label: 'Repeats caught while writing', color: 'var(--accent-primary)' }, ...(prKnown ? [{ label: 'Repeats that reached a PR', color: 'var(--status-warning)' }] : [])];
    const empty = weeks.every(w => w.repeatsStopped === 0 && !w.repeatsReachedPr);
    return (
        <Card title="Caught while writing vs reached a PR" meta="8 weeks">
            {empty
                ? <Empty>No repeat mistakes yet. A repeat is a problem that matches a lesson Rigour already learned; it shows here once an agent makes one again.</Empty>
                : <WeekChart weeks={weeks.map(w => ({ label: label(w.from), values: [w.repeatsStopped, ...(prKnown ? [w.repeatsReachedPr ?? 0] : [])] }))} series={series} />}
            <small className="week-note">
                Computed: a repeat matches, by its check and title, a lesson Rigour learned before.
                {prKnown ? '' : ' Repeats that reached a PR are not recorded here: they show once branch reviews run (rigour review --base main).'}
            </small>
        </Card>
    );
};

interface SetupCheck { id: string; name: string; state: 'working' | 'set up' | 'broken' | 'missing'; detail: string; fix?: string }

/** What setup found missing or broken, with the command that fixes each. */
export const SetupGaps: React.FC<{ onSetup: () => void }> = ({ onSetup }) => {
    const { data, error } = useStudioJson<{ checks: SetupCheck[] }>('/api/setup');
    const gaps = (data?.checks ?? []).filter(c => c.state === 'missing' || c.state === 'broken');
    return (
        <Card title="Setup gaps" meta={data ? (gaps.length ? plural(gaps.length, 'gap') : 'none') : undefined}>
            {error ? <Empty>Couldn't check setup: {error}.</Empty>
                : !data ? <span className="st-sub">Checking…</span>
                    : gaps.length === 0 ? <span className="st-sub">Everything setup checks is wired up.</span>
                        : gaps.map(g => (
                            <div className="week-gap" key={g.id}>
                                <div><Chip tone={g.state === 'broken' ? 'bad' : 'warn'}>{g.state}</Chip> {g.name}</div>
                                <small className="st-sub">{g.detail}</small>
                                {g.fix && <code className="ui-mono">{g.fix}</code>}
                            </div>
                        ))}
            <button type="button" className="ui-link" onClick={onSetup}>Open Setup</button>
        </Card>
    );
};


export const RecentPullsCard: React.FC<{ rows: PullRow[]; onOpen: () => void; scope?: PullsList['scope'] }> = ({ rows, onOpen, scope }) => (
    <Card title="Recent pull requests">
        {rows.length === 0
            ? <span className="st-sub">{scope?.older ? `No pull request with activity in the last ${scope.days} days.` : 'No pull request reviewed here yet.'}</span>
            : rows.slice(0, 5).map(r => (
                <div className="week-pull" key={r.key}>
                    <div><strong>{r.pr !== null ? `#${r.pr}` : 'Not opened yet'}</strong> {r.title ?? r.branches[0] ?? ''}</div>
                    <small className="st-sub">
                        {r.lastReview ? `${outcomeWords(r.lastReview.outcome).label} · ${r.lastReview.blocking} blocking` : 'not reviewed'} · {ago(r.lastActivity)}
                    </small>
                </div>
            ))}
    <button type="button" className="ui-link" onClick={onOpen}>All pull requests</button>
    </Card>
);
