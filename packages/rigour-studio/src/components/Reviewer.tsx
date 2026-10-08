/** The reviewer on Studio's pages: the verdict on the Review page, the settings on the Setup page. ReviewerParts.tsx draws them. */
import React, { useState } from 'react';
import { hasStudioKey, studioWrite } from '../studioWrite';
import { useStudioJson } from './storyData';
import { Agents, Settings, TeamDiff, Verdict, type ReviewerData } from './ReviewerParts';
import './story.css';

/** Loads the reviewer's state once for a part of a page; `reload` after a change. */
function useReviewer() {
    return useStudioJson<ReviewerData>('/api/reviewer');
}

/** On the Review page: the reviewer's verdict on this branch, first, because it is what blocks. */
export const BranchVerdict: React.FC = () => {
    const { data, error, reload } = useReviewer();
    if (error) return <div className="st-empty">Couldn't load the reviewer's verdict: {error}.</div>;
    if (!data) return <div className="st-sub">Loading…</div>;
    return <Verdict data={data} canWrite={hasStudioKey()} onChange={reload} />;
};

/** On the Setup page: how the reviewer runs, for you and for your team, and what this machine can run. */
export const ReviewerSetup: React.FC = () => {
    const { data, error, reload } = useReviewer();
    const [saving, setSaving] = useState<string | null>(null);
    const [problem, setProblem] = useState<string | null>(null);
    const [diff, setDiff] = useState<string | null>(null);
    if (error) return <div className="st-empty">Couldn't load the reviewer's settings: {error}.</div>;
    if (!data) return <div className="st-sub">Loading…</div>;
    const write = async (url: string, payload: unknown, key: string) => {
        setSaving(key);
        setProblem(null);
        const res = await studioWrite(url, 'POST', JSON.stringify(payload));
        const answer = await res.json().catch(() => ({}));
        if (!res.ok) setProblem(answer.error ?? `HTTP ${res.status}`);
        else if (url.endsWith('/team')) setDiff(answer.diff ?? null);
        setSaving(null);
        reload();
    };
    return (
        <section style={{ marginTop: 32 }}>
            <h2 style={{ margin: '0 0 6px', fontSize: 18, fontWeight: 600 }}>The reviewer</h2>
            <p className="st-sub" style={{ margin: '0 0 12px', lineHeight: 1.6 }}>
                A second opinion from other AI models, before a person reviews. Off until your team or you turn it on. With two or three judges from different
                vendors, a finding blocks only when most of them agree and it names what goes wrong.
            </p>
            <Settings data={data} canWrite={hasStudioKey()} saving={saving}
                onSave={patch => write('/api/reviewer/settings', patch, Object.keys(patch)[0])}
                onSaveTeam={(patch, create) => write('/api/reviewer/team', { patch, create }, `team:${Object.keys(patch)[0]}`)} />
            {problem && <div className="st-card" style={{ marginTop: 12 }}><span className="st-chip bad">not saved</span> <span className="st-sub">{problem}</span></div>}
            {diff && <TeamDiff diff={diff} />}
            <Agents data={data} />
        </section>
    );
};

