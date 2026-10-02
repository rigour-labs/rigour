import React from 'react';
import { plural, useStudioJson, inlineCode } from './storyData';
import './story.css';

interface ProgressWeek {
    from: string;
    stopped: number;
    overruled: number;
    repeatsStopped: number;
    repeatsReachedPr: number | null;
    minutesToFix: number | null;
    lessons: number;
}
interface ProgressData {
    weeks: ProgressWeek[];
    topLessons: Array<{ id: string; text: string; stoppedInDevelopment: number | null; scope: string }>;
    checks: Array<{ check: string; fixed: number; dismissed: number; precision: number; muted: boolean }>;
}

const label = (from: string) => new Date(from).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const sum = (weeks: ProgressWeek[], pick: (w: ProgressWeek) => number) => weeks.reduce((n, w) => n + pick(w), 0);

/** "Progress": how Rigour is shaping this codebase week by week. Rankings are of lessons and checks, never people. */
export const Progress: React.FC = () => {
    const { data, error } = useStudioJson<ProgressData>('/api/progress');
    if (error) return <div className="st-page"><div className="st-empty">Couldn't load progress: {error}.</div></div>;
    if (!data) return <div className="st-page"><div className="st-sub">Loading…</div></div>;
    const recent = data.weeks.slice(-4);
    const earlier = data.weeks.slice(0, -4);
    const lessonsNow = data.weeks[data.weeks.length - 1]?.lessons ?? 0;
    return (
        <div className="st-page">
            <h1 className="st-h1">How Rigour is shaping this code</h1>
            <p className="st-lead">
                Last 4 weeks: {plural(sum(recent, w => w.stopped), 'problem')} stopped before a PR
                {earlier.length ? ` (${sum(earlier, w => w.stopped)} in the 4 weeks before)` : ''}, {plural(sum(recent, w => w.repeatsStopped), 'repeat mistake')} caught,
                {' '}{plural(lessonsNow, 'lesson')} learned so far.
            </p>

            <div className="st-stack" style={{ marginTop: 24 }}>
                <Trend title="Stopped before a PR" hint="fixed by the agent after Rigour reported it" weeks={data.weeks} value={w => w.stopped} />
                <Trend title="Repeat mistakes stopped" hint="a mistake Rigour had already learned, caught again before a PR" weeks={data.weeks} value={w => w.repeatsStopped} />
                <Trend title="Repeat mistakes that reached a PR" hint="lower is better" weeks={data.weeks} value={w => w.repeatsReachedPr}
                    empty="Shows once branch reviews run on this machine, for example rigour review --base main in a pre-push hook." />
                <Trend title="Minutes from report to fix" hint="median; lower is better" weeks={data.weeks} value={w => w.minutesToFix} />
                <Trend title="Overruled" hint="findings someone marked not a bug" weeks={data.weeks} value={w => w.overruled} />
                <Trend title="Lessons learned" hint="total by the end of each week" weeks={data.weeks} value={w => w.lessons} />
            </div>

            <div className="st-grid" style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }}>
                <section className="st-card">
                    <strong>Lessons that stopped the most repeats</strong>
                    {data.topLessons.length === 0
                        ? <div className="st-sub" style={{ marginTop: 10, lineHeight: 1.6 }}>None yet. A lesson ranks here once the mistake it describes is caught again and stopped.</div>
                        : <ol style={{ margin: '12px 0 0', paddingLeft: 20, lineHeight: 1.6 }}>{data.topLessons.map(l => (
                            <li key={l.id} style={{ marginBottom: 8 }}>{inlineCode(l.text)}<div className="st-sub">{plural(l.stoppedInDevelopment ?? 0, 'repeat')} stopped · {l.scope === 'team' ? 'shared with team' : l.scope}</div></li>
                        ))}</ol>}
                </section>
                <section className="st-card">
                    <strong>Checks your team acts on</strong>
                    {data.checks.length === 0
                        ? <div className="st-sub" style={{ marginTop: 10, lineHeight: 1.6 }}>Each fix and each "not a bug" scores the check that raised it. Scores appear after the first one.</div>
                        : <div className="st-stack" style={{ marginTop: 12, gap: 8 }}>{data.checks.map(c => (
                            <div key={c.check} className="st-row" style={{ gap: 10 }}>
                                <span style={{ width: 44, fontWeight: 600 }}>{Math.round(c.precision * 100)}%</span>
                                <span style={{ flex: 1, fontSize: 14 }}>{c.check}</span>
                                <span className="st-sub">{c.fixed} fixed · {c.dismissed} overruled</span>
                                {c.muted && <span className="st-chip">quiet</span>}
                            </div>
                        ))}</div>}
                </section>
            </div>
        </div>
    );
};

export const Trend: React.FC<{ title: string; hint: string; weeks: ProgressWeek[]; value: (w: ProgressWeek) => number | null; empty?: string }> = ({ title, hint, weeks, value, empty }) => {
    const values = weeks.map(value);
    const known = values.filter((v): v is number => v !== null);
    const peak = Math.max(1, ...known);
    return (
        <div className="st-card">
            <div className="st-row" style={{ justifyContent: 'space-between' }}><strong>{title}</strong><span className="st-sub">{hint}</span></div>
            {known.length === 0 && empty
                ? <div className="st-sub" style={{ marginTop: 10 }}>{empty}</div>
                : (
                    <div className="st-bars" style={{ height: 90, gap: 12 }}>
                        {weeks.map((w, i) => (
                            <div className="st-bar" key={w.from}>
                                <div style={{ fontSize: 12 }}>{values[i] ?? '—'}</div>
                                <span style={{ height: `${values[i] === null ? 2 : Math.max(2, ((values[i] as number) / peak) * 56)}px`, opacity: values[i] === null ? 0.25 : 1 }} />
                                <div className="st-sub" style={{ fontSize: 11 }}>{label(w.from)}</div>
                            </div>
                        ))}
                    </div>
                )}
        </div>
    );
};
