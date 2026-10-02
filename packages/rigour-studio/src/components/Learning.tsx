import React from 'react';
import { studioWrite } from '../studioWrite';
import { useStudioJson, inlineCode } from './storyData';
import './story.css';

interface Journey {
    id: string;
    text: string;
    origin: 'development' | 'pr' | 'memory';
    learnedFrom: string;
    state: string;
    scope: string;
    told: number;
    stoppedInDevelopment: number | null;
    reachedPr: number | null;
    canDecide: boolean;
}
interface LearningData {
    lessons: Journey[];
    weeks: Array<{ from: string; stoppedInDevelopment: number; reachedPr: number | null }>;
    prRecorded: boolean;
}

/** null means unknown on this machine; a lesson that is not about a kind of defect has no repeats to count. */
const times = (n: number | null, counted = true) => (!counted ? '—' : n === null ? 'not recorded here' : n === 1 ? '1 time' : `${n} times`);

/** "How it learns": each lesson's path across development and the PR, and whether repeats still reach a PR. */
export const Learning: React.FC = () => {
    const { data, error, reload } = useStudioJson<LearningData>('/api/learning');
    if (error) return <div className="st-page"><div className="st-empty">Couldn't load lessons: {error}.</div></div>;
    if (!data) return <div className="st-page"><div className="st-sub">Loading…</div></div>;
    const decide = async (id: string, state: 'validated' | 'promoted' | 'rejected') => {
        const res = await studioWrite('/api/lessons', 'POST', JSON.stringify({ id, state }));
        if (res.ok) reload();
    };
    const peak = Math.max(1, ...data.weeks.map(w => Math.max(w.stoppedInDevelopment, w.reachedPr ?? 0)));
    return (
        <div className="st-page">
            <h1 className="st-h1">How Rigour learns your codebase</h1>
            <p className="st-lead">Every mistake fixed in development or caught at a PR becomes a lesson. Your agents are told before they write similar code, so the same mistake is stopped earlier next time.</p>

            <section className="st-card" style={{ margin: '24px 0' }}>
                <div className="st-row" style={{ justifyContent: 'space-between' }}>
                    <strong>Repeat mistakes, by week</strong>
                    <span className="st-sub">a mistake Rigour had already learned</span>
                </div>
                <div className="st-bars">
                    {data.weeks.map(w => (
                        <div className="st-bar" key={w.from}>
                            <div style={{ fontSize: 13 }}>{w.stoppedInDevelopment} stopped{w.reachedPr === null ? '' : ` · ${w.reachedPr} reached a PR`}</div>
                            <span style={{ height: `${Math.max(4, (w.stoppedInDevelopment / peak) * 80)}px` }} />
                            <div className="st-sub">from {new Date(w.from).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</div>
                        </div>
                    ))}
                </div>
                {!data.prRecorded && (
                    <div className="st-sub" style={{ marginTop: 14 }}>Repeats that reached a PR show once branch reviews run on this machine (<span className="st-mono">rigour review --base main</span>, for example in a pre-push hook). Reviews in CI stay in CI.</div>
                )}
            </section>

            {data.lessons.length === 0
                ? <div className="st-empty">No lessons yet. They form when an agent fixes something Rigour reported, when a PR comment leads to a fix, or when you tell your agent to remember something.</div>
                : <div className="st-stack">{data.lessons.map(l => <LessonCard key={l.id} lesson={l} onDecide={decide} />)}</div>}
            <OtherKnowledge />
        </div>
    );
};

export const LessonCard: React.FC<{ lesson: Journey; onDecide: (id: string, state: 'validated' | 'promoted' | 'rejected') => void }> = ({ lesson, onDecide }) => (
    <div className="st-card">
        <div className="st-row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div style={{ fontSize: 17, lineHeight: 1.5, flex: 1 }}>{inlineCode(lesson.text)}</div>
            <span className="st-chip">{lesson.scope === 'team' ? 'shared with team' : lesson.scope}</span>
        </div>
        <div className="st-journey">
            <div style={{ background: 'var(--bg-surface)' }}><div className="st-sub">Learned</div><div style={{ fontSize: 14, marginTop: 4 }}>{lesson.learnedFrom}</div></div>
            <div><div className="st-sub">Agents told</div><div style={{ fontSize: 14, marginTop: 4 }}>{times(lesson.told)}</div></div>
            <div><div className="st-sub">Stopped in development</div><div style={{ fontSize: 14, marginTop: 4 }}>{times(lesson.stoppedInDevelopment, lesson.origin === 'development')}</div></div>
            <div><div className="st-sub">Reached a PR again</div><div style={{ fontSize: 14, marginTop: 4 }}>{times(lesson.reachedPr, lesson.origin === 'development')}</div></div>
        </div>
        {lesson.canDecide && (
            <div className="st-row" style={{ marginTop: 14 }}>
                <span className="st-sub">{lesson.scope === 'team' ? 'Shared by a teammate. Give it to everyone\'s agents?' : 'Seen once. Keep it so your agents get told?'}</span>
                <button className="st-btn primary" onClick={() => onDecide(lesson.id, lesson.scope === 'team' ? 'promoted' : 'validated')} type="button">{lesson.scope === 'team' ? 'Share with team' : 'Keep'}</button>
                <button className="st-btn" onClick={() => onDecide(lesson.id, 'rejected')} type="button">Drop</button>
            </div>
        )}
    </div>
);

interface LearnedRule { id: string; message: string; requirement: string; appliesTo: string }
interface MemoryData { memories: Record<string, { value: string; timestamp?: string; source?: string }> }

/** The rest of what Rigour knows: rules it enforces from fixes, facts agents were told, and the functions it can point to. */
const OtherKnowledge: React.FC = () => {
    const rules = useStudioJson<LearnedRule[]>('/api/learned-rules').data ?? [];
    const memories = Object.entries(useStudioJson<MemoryData>('/api/memory').data?.memories ?? {});
    const patterns = useStudioJson<{ stats?: { totalPatterns?: number } }>('/api/index-stats').data?.stats?.totalPatterns;
    return (
        <div className="st-grid" style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }}>
            <section className="st-card">
                <strong>Rules learned from fixes</strong>
                <div className="st-sub" style={{ marginTop: 4 }}>Checked on every edit, like a built-in check.</div>
                {rules.length === 0
                    ? <div className="st-sub" style={{ marginTop: 10, lineHeight: 1.6 }}>None yet. rigour learn turns an agent's fixes into rules once they hold up.</div>
                    : <ul style={{ margin: '10px 0 0', paddingLeft: 18, lineHeight: 1.6, fontSize: 14 }}>{rules.map(r => <li key={r.id}>{r.message}<div className="st-sub">{r.requirement} · {r.appliesTo}</div></li>)}</ul>}
            </section>
            <section className="st-card">
                <strong>What your agents were told to remember</strong>
                <div className="st-sub" style={{ marginTop: 4 }}>Facts saved with rigour_remember; agents recall them by meaning.</div>
                {memories.length === 0
                    ? <div className="st-sub" style={{ marginTop: 10, lineHeight: 1.6 }}>Nothing saved yet.</div>
                    : <ul style={{ margin: '10px 0 0', paddingLeft: 18, lineHeight: 1.6, fontSize: 14 }}>{memories.slice(0, 12).map(([key, m]) => <li key={key}><strong>{key.replace(/_/g, ' ')}</strong>: {m.value.length > 220 ? `${m.value.slice(0, 220)}…` : m.value}</li>)}</ul>}
                {memories.length > 12 && <div className="st-sub" style={{ marginTop: 6 }}>and {memories.length - 12} more</div>}
            </section>
            {typeof patterns === 'number' && patterns > 0 && (
                <section className="st-card" style={{ gridColumn: '1 / -1' }}>
                    <strong>{patterns} functions indexed</strong>
                    <div className="st-sub" style={{ marginTop: 4, lineHeight: 1.6 }}>Before an agent writes a new helper, Rigour checks whether one already exists and points to it, so the codebase doesn't fill with near-copies.</div>
                </section>
            )}
        </div>
    );
};
