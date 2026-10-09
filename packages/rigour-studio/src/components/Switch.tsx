/** A switch on Studio's Setup page (the goal check, ...): loads its state and saves changes. SwitchParts.tsx draws it. */
import React, { useState } from 'react';
import { hasStudioKey, studioWrite } from '../studioWrite';
import { useStudioJson } from './storyData';
import { SwitchSettings, type SwitchData, type SwitchText } from './SwitchParts';
import './story.css';

/** Each switch's words, by the name its API route takes. */
const TEXT: Record<'goal' | 'outcomes' | 'orchestrator', SwitchText> = {
    goal: {
        title: 'The goal check',
        lead: <>Checks a change against what its pull request says it is for: files outside its <span className="st-mono">Scope</span> or inside <span className="st-mono">Out of scope</span>, and{' '}
            <span className="st-mono">Done when</span> items naming a file it never touched, block. No model; a description without these sections is never checked.</>,
        row: 'Check the goal',
        rowHelp: <>Required: no person, environment variable or flag may turn it off. <span className="st-mono">--goal</span> and <span className="st-mono">--no-goal</span> choose for one run.</>,
        name: 'goal check',
    },
    outcomes: {
        title: 'The outcome loop',
        lead: <>What happened after each pull request merged: CI on its merge commit, later commits and fixes on its files, a revert. Read with{' '}
            <span className="st-mono">rigour outcomes</span>, one GitHub call per merged pull request until its window closes, then never again.</>,
        row: 'Read outcomes',
        rowHelp: <>Required: no person, environment variable or flag may turn it off. <span className="st-mono">--outcomes</span> and <span className="st-mono">--no-outcomes</span> choose for one run.</>,
        name: 'outcome loop',
    },
    orchestrator: {
        title: 'The review orchestrator',
        lead: <>Experimental. Triage, without a model, picks which parts of a review each change needs (earlier human points,
            correctness, production cost, what the change leaves behind, rules, lessons and the goal), and the judge does only those,
            in one pass: the same runs as one judge. A change over the judge's limit is split only with what the router has already
            saved over its last 20 reviews, so on average it never costs more than one judge. A change with nothing for a model to review gets no run. Under required, every part returns or there is no verdict. The daily caps
            (<span className="st-mono">max_runs_per_day</span>, <span className="st-mono">max_usd_per_day</span>) count every pass. What blocks is unchanged.</>,
        row: 'Use the orchestrator',
        rowHelp: <>Required: no person, environment variable or flag may turn it off. <span className="st-mono">--orchestrator</span> and <span className="st-mono">--no-orchestrator</span> choose for one run.</>,
        name: 'review orchestrator',
    },
};

export const SwitchSetup: React.FC<{ name: keyof typeof TEXT }> = ({ name }) => {
    const url = `/api/switches/${name}`;
    const { data, error, reload } = useStudioJson<SwitchData>(url);
    const [saving, setSaving] = useState(false);
    const [problem, setProblem] = useState<string | null>(null);
    const [diff, setDiff] = useState<string | null>(null);
    if (error) return <div className="st-empty">Couldn't load the {TEXT[name].name}: {error}.</div>;
    if (!data) return <div className="st-sub">Loading…</div>;
    const write = async (payload: Record<string, unknown>) => {
        setSaving(true);
        setProblem(null);
        const res = await studioWrite(url, 'POST', JSON.stringify(payload));
        const answer = await res.json().catch(() => ({}));
        if (!res.ok) setProblem(answer.error ?? `HTTP ${res.status}`);
        else if ('team' in payload) setDiff(answer.diff ?? null);
        setSaving(false);
        reload();
    };
    return <SwitchSettings text={TEXT[name]} data={data} canWrite={hasStudioKey()} saving={saving} problem={problem} diff={diff} onSave={write} />;
};
