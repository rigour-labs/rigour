/** The goal check on Studio's Setup page (docs/GOAL.md): loads its state and saves changes. GoalParts.tsx draws it. */
import React, { useState } from 'react';
import { hasStudioKey, studioWrite } from '../studioWrite';
import { useStudioJson } from './storyData';
import { GoalSettings, type GoalData } from './GoalParts';
import './story.css';

export const GoalSetup: React.FC = () => {
    const { data, error, reload } = useStudioJson<GoalData>('/api/goal');
    const [saving, setSaving] = useState(false);
    const [problem, setProblem] = useState<string | null>(null);
    const [diff, setDiff] = useState<string | null>(null);
    if (error) return <div className="st-empty">Couldn't load the goal check: {error}.</div>;
    if (!data) return <div className="st-sub">Loading…</div>;
    const write = async (payload: Record<string, unknown>) => {
        setSaving(true);
        setProblem(null);
        const res = await studioWrite('/api/goal', 'POST', JSON.stringify(payload));
        const answer = await res.json().catch(() => ({}));
        if (!res.ok) setProblem(answer.error ?? `HTTP ${res.status}`);
        else if ('team' in payload) setDiff(answer.diff ?? null);
        setSaving(false);
        reload();
    };
    return <GoalSettings data={data} canWrite={hasStudioKey()} saving={saving} problem={problem} diff={diff} onSave={write} />;
};
