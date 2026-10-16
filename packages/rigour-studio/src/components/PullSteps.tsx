/** One pull request's timeline, step by step, each with what was recorded or how to record it. */
import React from 'react';
import { plural } from './storyData';
import { Chip, type TimelineStep } from './ui';
import { ciWords, COST_NOTE, costWords, outcomeWords, type PullDetail, type Round } from './pullsData';

const when = (at: string) => new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

const Missing: React.FC<{ children: React.ReactNode }> = ({ children }) => <p className="pulls-missing">Not recorded on this machine. {children}</p>;

const agentsLine = (agents: string[]) => (agents.length ? `by ${agents.join(', ')}` : 'agent not recorded');

export function timelineSteps(d: PullDetail): TimelineStep[] {
    const s = d.steps;
    return [briefStep(s.brief), editStep(s.edits), stopStep(s.stop), pushStep(s.push), ...reviewSteps(s.reviews), humanStep(d), mergeStep(d)];
}

type Steps = PullDetail['steps'];

function briefStep(b: Steps['brief']): TimelineStep {
    return {
        key: 'brief', title: 'Briefed', when: b ? when(b.at) : undefined, tone: b ? 'done' : 'todo',
        children: b
            ? <p>{plural(b.count, 'brief')}, {plural(b.items, 'lesson or rule', 'lessons and rules')} told before writing ({agentsLine(b.agents)}).</p>
            : <Missing>The brief is recorded when an agent starts work with Rigour's hooks installed (<span className="ui-mono">rigour setup</span>).</Missing>,
    };
}

function editStep(e: Steps['edits']): TimelineStep {
    return {
        key: 'edits', title: 'Checked while writing', when: e ? when(e.at) : undefined, tone: e ? (e.findings ? 'bad' : 'ok') : 'todo',
        children: e
            ? <p>{plural(e.checks, 'edit')} checked across {plural(e.files, 'file')}: {plural(e.findings, 'finding')}{e.flagged ? `, ${e.cleaned} of ${plural(e.flagged, 'flagged file')} clean again by a later edit` : ''} ({agentsLine(e.agents)}).</p>
            : <Missing>Each edit is checked when the edit hook is installed (<span className="ui-mono">rigour setup</span>).</Missing>,
    };
}

function stopStep(st: Steps['stop']): TimelineStep {
    return {
        key: 'stop', title: 'Agent said done', when: st ? when(st.at) : undefined, tone: st ? (st.blocked ? 'bad' : 'ok') : 'todo',
        children: st
            ? <p>{plural(st.count, 'time')}: {st.blocked} held back with problems to fix, {st.clean} clean ({agentsLine(st.agents)}).</p>
            : <Missing>Recorded when the stop hook reviews the agent's work before it says done (<span className="ui-mono">rigour setup</span>).</Missing>,
    };
}

function pushStep(p: Steps['push']): TimelineStep {
    return {
        key: 'push', title: 'Push check', when: p ? when(p.at) : undefined, tone: p ? (p.failed ? 'bad' : 'ok') : 'todo',
        children: p
            ? <p>{plural(p.count, 'push', 'pushes')}: {p.passed} passed, {p.failed} held back.</p>
            : <Missing>Recorded when Rigour checks a push; see Setup.</Missing>,
    };
}

function reviewSteps(rounds: Round[]): TimelineStep[] {
    if (!rounds.length) return [{ key: 'review', title: "Rigour's review", tone: 'todo', children: <Missing>Run <span className="ui-mono">rigour review --reviewer</span>, or turn on review at push in Setup.</Missing> }];
    return rounds.map((r, i) => ({
        key: `review-${i}`,
        title: rounds.length > 1 ? `Rigour's review, round ${i + 1}` : "Rigour's review",
        when: when(r.at),
        tone: r.outcome === 'passed' ? 'ok' : r.outcome === 'findings' ? 'bad' : 'done',
        children: <RoundBody round={r} />,
    }));
}

const RoundBody: React.FC<{ round: Round }> = ({ round: r }) => {
    const words = outcomeWords(r.outcome);
    return (
        <div className="pulls-round">
            <div className="pulls-review"><Chip tone={words.tone}>{words.label}</Chip><span>{plural(r.blocking, 'blocking problem')} · {r.shouldFix} should fix{r.head ? <> · at <span className="ui-mono">{r.head.slice(0, 9)}</span></> : null}</span></div>
            <JudgesLine round={r} />
            <RulesBlock round={r} />
            {r.lessons.applied.length > 0 && (
                <ul className="pulls-list">{r.lessons.applied.map(l => <li key={l.id}>Repeats a team lesson: {l.text ?? <span className="ui-mono">{l.id}</span>}</li>)}</ul>
            )}
            {r.recorded && !r.lessons.applied.length && <p className="pulls-dim">{r.lessons.served ? `${plural(r.lessons.served, 'team lesson')} served; none repeated.` : 'No team lesson applied to these files.'}</p>}
            {r.disputed ? <p className="pulls-dim">{r.disputed} disputed between judges, never blocking.</p> : null}
            {r.cost.length > 0 && <p className="pulls-dim" title={COST_NOTE}>Cost: {r.cost.map(costWords).join('; ')}.</p>}
        </div>
    );
};

const JudgesLine: React.FC<{ round: Round }> = ({ round: r }) => {
    const judges = r.judges.map(j => `${j.reviewer}${j.model ? ` (${j.model})` : ''}`).join(', ');
    return <p className="pulls-dim">Judged by {judges || 'judges not recorded'}{r.judges.length && r.judges.every(j => !j.model) ? ' (model not recorded)' : ''}.{r.blind ? ' Reviewed without the pull request\'s description or comments.' : ''}</p>;
};

const RulesBlock: React.FC<{ round: Round }> = ({ round: r }) => (
    <>
        {r.rules
            ? <p>Repository rules: {r.rules.followed} followed, {r.rules.broken} broken, {r.rules.notApplicable} not relevant, of {r.rules.served} served.</p>
            : <p className="pulls-dim">Rules and lessons not recorded here: this review's record is not on this machine.</p>}
        {r.rules?.brokenNames.length ? <ul className="pulls-list">{r.rules.brokenNames.map((name, i) => <li key={`${name}-${i}`}>Broken: {name}</li>)}</ul> : null}
    </>
);

function humanStep(d: PullDetail): TimelineStep {
    const h = d.steps.human;
    const known = h.reviews !== null || h.points.length > 0;
    return {
        key: 'human', title: 'Human review', tone: known ? 'done' : 'todo',
        children: !known ? <Missing>The reviewer records people's reviews it read; <span className="ui-mono">rigour learn-reviews</span> turns their points into lessons.</Missing> : (
            <>
                <p>{h.reviews === null ? 'Number of reviews not recorded.' : `${plural(h.reviews, 'review')} by people, as the reviewer read them.`} {h.points.length ? `${plural(h.points.length, 'point')} became lessons:` : 'No point from it became a lesson yet.'}</p>
                {h.points.length > 0 && <ul className="pulls-list">{h.points.map((p, i) => (
                    <li key={`${p.lesson}-${i}`}>{p.lesson} <span className="pulls-dim">· {p.author}{p.source === 'bot' ? ' (a bot)' : ''} · {p.state}</span></li>
                ))}</ul>}
            </>
        ),
    };
}

function mergeStep(d: PullDetail): TimelineStep {
    const m = d.steps.merge;
    if (d.pr === null) return { key: 'merge', title: 'Merged and after', tone: 'todo', children: <p className="pulls-dim">No pull request yet.</p> };
    if (!m) return { key: 'merge', title: 'Merged and after', tone: 'todo', children: <Missing>Run <span className="ui-mono">rigour outcomes</span> to read the merge, CI and later fixes from GitHub.</Missing> };
    return {
        key: 'merge', title: m.reverted ? 'Merged, then reverted' : 'Merged and after', when: when(m.at), tone: m.reverted || m.ci === 'failure' ? 'bad' : 'ok',
        children: (
            <>
                <p>{m.author ? `Written by ${m.author}. ` : ''}CI after merge: {ciWords(m.ci)}. {m.followUpCount === null ? 'Follow-ups not recorded yet (the window is still open).' : `${plural(m.followUpCount, 'later commit')} on main touched its files, ${plural(m.fixes ?? 0, 'fix', 'fixes')}.`}{m.settled ? '' : ' Still being watched.'}</p>
                {m.reverted?.subject && <p>Reverted by <span className="ui-mono">{m.reverted.sha?.slice(0, 9)}</span> {m.reverted.subject}</p>}
                {m.followUps && m.followUps.length > 0 && <ul className="pulls-list">{m.followUps.map(f => <li key={f.sha}><span className="ui-mono">{f.sha.slice(0, 9)}</span> {f.subject}{f.fix ? <> <Chip tone="warn">fix</Chip></> : null}</li>)}</ul>}
            </>
        ),
    };
}
