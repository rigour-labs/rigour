/** One pull request: its facts and its timeline, from the first recorded event to the merge and after. */
import React from 'react';
import { Card, Chip, Empty, Kpis, PageHeader, Row, Timeline, formatCount, type KpiItem } from './ui';
import { COST_NOTE, costWords, duration, prLabel, STATE_WORDS, type PullAnswer, type PullDetail } from './pullsData';
import { timelineSteps } from './PullSteps';
import './pulls.css';

export const PullView: React.FC<{ answer: PullAnswer; onBack: () => void }> = ({ answer, onBack }) => (
    <div className="ui-page">
        <button type="button" className="ui-link pulls-back" onClick={onBack}>← All pull requests</button>
        {answer.found ? <PullBody d={answer} /> : <Empty>Nothing recorded on this machine for {answer.key || 'that pull request'}.</Empty>}
    </div>
);

const PullBody: React.FC<{ d: PullDetail }> = ({ d }) => {
    const state = STATE_WORDS[d.state];
    return (
        <>
            <PageHeader
                title={`${prLabel(d)}${d.title ? ` ${d.title}` : ''}`}
                lead={<>Branch <span className="ui-mono">{d.branches.join(', ')}</span>. First recorded {new Date(d.firstAt).toLocaleString()}.</>}
                aside={<span title={state.note}><Chip tone={state.tone}>{state.label}</Chip></span>}
            />
            <Kpis items={factKpis(d)} />
            <div className="ui-cols">
                <div className="ui-col">
                    <Card title="From the first edit to the merge" meta="each step as Rigour recorded it"><Timeline steps={timelineSteps(d)} /></Card>
                </div>
                <div className="ui-col">
                    <FactsCard d={d} />
                </div>
            </div>
        </>
    );
};

function factKpis(d: PullDetail): KpiItem[] {
    const c = d.facts.caughtBeforeReview;
    return [
        { label: 'Caught before review', value: c ? c.findings + c.stops + c.pushes : '—', note: c ? <span title="Edit-check findings, plus times the agent was held back at done or at push, before the first review round.">{c.findings} at edits · {c.stops} at done · {c.pushes} at push</span> : 'no hooked agent work recorded before the review' },
        { label: 'Repeats caught', value: d.facts.rounds ? d.facts.repeats.length : '—', note: 'team lessons the review found repeated' },
        { label: 'Review rounds', value: d.facts.rounds || '—', note: d.facts.rounds ? 'Rigour reviews of this branch' : 'no Rigour review recorded' },
        { label: 'First event to merge', value: d.facts.durationMs === null ? '—' : duration(d.facts.durationMs), note: d.facts.durationMs === null ? (d.pr === null ? 'no pull request yet' : 'merge not recorded: run rigour outcomes') : 'from the first recorded event' },
    ];
}

interface JudgeRow { reviewer: string; versions: string[]; models: string[]; unrecorded: boolean; runs: number; usd: number | null; costs: string[] }

/** One row per judge across every round: its models (or "model not recorded" once), its runs, and the dollars it reported. */
function judgeRows(facts: PullDetail['facts']): JudgeRow[] {
    const rows = new Map<string, JudgeRow>();
    for (const j of facts.judges) {
        const row = rows.get(j.reviewer) ?? { reviewer: j.reviewer, versions: [], models: [], unrecorded: false, runs: 0, usd: null, costs: [] };
        row.runs += j.runs;
        if (j.model && !row.models.includes(j.model)) row.models.push(j.model);
        if (!j.model) row.unrecorded = true;
        if (j.version && !row.versions.includes(j.version)) row.versions.push(j.version);
        rows.set(j.reviewer, row);
    }
    for (const c of facts.cost) {
        const row = rows.get(c.by);
        if (!row) continue;
        row.usd = (row.usd ?? 0) + c.usd;
        row.costs.push(costWords(c));
    }
    return [...rows.values()];
}

const modelWords = (r: JudgeRow) => (r.models.length ? `${r.models.join(', ')}${r.unrecorded ? ', model not recorded' : ''}` : 'model not recorded');

const JudgeRows: React.FC<{ facts: PullDetail['facts'] }> = ({ facts }) => {
    const rows = judgeRows(facts);
    const total = facts.cost.reduce((n, c) => n + c.usd, 0);
    return (
        <>
            <div className="pulls-judges" role="table" aria-label="Judges">
                <div role="row" className="pulls-judge head"><span role="columnheader">Judge</span><span role="columnheader">Runs</span><span role="columnheader">Reported cost</span></div>
                {rows.map(r => (
                    <div role="row" className="pulls-judge" key={r.reviewer}>
                        <span role="cell"><strong>{r.reviewer}{r.versions.length ? ` ${r.versions.join(', ')}` : ''}</strong><small className="pulls-dim">{modelWords(r)}</small></span>
                        <span role="cell" className="num">{formatCount(r.runs)}</span>
                        <span role="cell" className="num" title={r.costs.join('; ') || undefined}>{r.usd === null ? '—' : `$${r.usd.toFixed(2)}`}</span>
                    </div>
                ))}
            </div>
            {facts.cost.length > 0
                ? <><Row label="Total reported" value={<span title={COST_NOTE}>${total.toFixed(2)}</span>} /><p className="pulls-dim">{COST_NOTE}</p></>
                : <p className="pulls-dim">No judge reported a cost for these runs.</p>}
        </>
    );
};

const FactsCard: React.FC<{ d: PullDetail }> = ({ d }) => (
    <Card title="The reviewer">
        {d.facts.judges.length === 0
            ? <Empty>No reviewer run recorded. Run <span className="ui-mono">rigour review --reviewer</span> on the branch.</Empty>
            : <JudgeRows facts={d.facts} />}
        {d.facts.repeats.length > 0 && (
            <>
                <strong className="pulls-sub">Lessons it repeated</strong>
                <ul className="pulls-list">{d.facts.repeats.map(l => <li key={l.id}>{l.text ?? <span className="ui-mono">{l.id}</span>}</li>)}</ul>
            </>
        )}
    </Card>
);
