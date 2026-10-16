/** The Memory page's tabs and numbers: what is in force, what agents were told, what was remembered, and review evidence. Learning.tsx loads the data. */
import React from 'react';
import { inlineCode, plural } from './storyData';
import { Card, Chip, Empty, Table, WeekChart, type KpiItem } from './ui';
import type { EvidenceItem, Journey } from './LearningParts';
import './memory.css';

export interface LearningWeek { from: string; stoppedInDevelopment: number; reachedPr: number | null }
export interface Briefed { lessons: number; requests: number; days: number }
export interface Memory { value: string; timestamp?: string; source?: string }
export interface LearnedRule { id: string; message: string; requirement: string; appliesTo: string }

const IN_FORCE = new Set(['validated', 'promoted', 'verified']);
const shortDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

/** The page's four numbers. Repeats stopped is computed, and says so. */
export function memoryKpis(lessons: Journey[], weeks: LearningWeek[], briefed?: Briefed): KpiItem[] {
    const waiting = lessons.filter(l => l.canDecide && !l.fromBots).length;
    const bots = lessons.filter(l => l.canDecide && l.fromBots).length;
    return [
        { label: 'Lessons in force', value: lessons.filter(l => IN_FORCE.has(l.state)).length, note: 'Kept by a person or by evidence; agents are given these.' },
        {
            label: `Briefed to agents, ${briefed?.days ?? 28} days`,
            value: briefed ? briefed.lessons : '—',
            note: briefed ? `${plural(briefed.requests, 'request')}: briefs, recalls and reviews on this machine.` : 'Not recorded by this version of Rigour.',
        },
        {
            label: 'Repeats stopped',
            value: weeks.reduce((n, w) => n + w.stoppedInDevelopment, 0),
            note: <span title="Computed: a problem caught later with the same rule and title as a lesson learned before it.">Computed over {weeks.length} weeks: the same problem caught again before a PR.</span>,
        },
        { label: 'Waiting for a person', value: waiting, note: bots ? `Plus ${plural(bots, 'candidate')} only review bots raised.` : 'Candidates a person keeps or drops.' },
    ];
}

/** Repeats of a learned mistake, by week: stopped in development, and reaching a PR where branch reviews run here. */
export const RepeatsCard: React.FC<{ weeks: LearningWeek[]; prRecorded: boolean }> = ({ weeks, prRecorded }) => {
    const series = [{ label: 'stopped in development', color: 'var(--accent-primary)' }, ...(prRecorded ? [{ label: 'reached a PR', color: 'var(--status-warning)' }] : [])];
    const bars = weeks.map(w => ({ label: new Date(w.from).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }), values: [w.stoppedInDevelopment, ...(prRecorded ? [w.reachedPr ?? 0] : [])] }));
    return (
        <Card title="Repeat mistakes, by week" meta="computed from the lesson's rule and title">
            {weeks.every(w => w.stoppedInDevelopment + (w.reachedPr ?? 0) === 0)
                ? <Empty>No learned mistake came back in these weeks. When an agent is about to repeat one, it is counted here.</Empty>
                : <WeekChart weeks={bars} series={series} />}
            {!prRecorded && <div className="mem-note">Repeats that reached a PR show once branch reviews run on this machine (<code>rigour review --base main</code>, for example in a pre-push hook). Reviews in CI stay in CI.</div>}
        </Card>
    );
};

const WHERE: Record<string, string> = { project: 'this repository', global: 'you, every repository' };

/** Facts agents were told to remember, with where each is kept and when it was saved. */
export const RememberedTable: React.FC<{ memories: Array<[string, Memory]> }> = ({ memories }) => {
    if (memories.length === 0) {
        return <Empty>Nothing remembered yet. When you tell an agent to remember something, it saves it with the <code>rigour_remember</code> tool, and it shows here with where it is kept and when it was saved.</Empty>;
    }
    const sorted = [...memories].sort((a, b) => (b[1].timestamp ?? '').localeCompare(a[1].timestamp ?? ''));
    return (
        <Card title="What agents were told to remember" meta={plural(memories.length, 'fact')} flush>
            <Table
                rows={sorted}
                rowKey={([key]) => key}
                columns={[
                    { label: 'What', wrap: true, cell: ([key, m]) => <div className="mem-value"><strong>{key.replace(/^(project|global):/, '').replace(/_/g, ' ')}</strong>: {m.value.length > 280 ? `${m.value.slice(0, 280)}…` : m.value}</div> },
                    { label: 'Kept for', cell: ([, m]) => WHERE[m.source ?? ''] ?? 'not recorded' },
                    { label: 'Saved', cell: ([, m]) => (m.timestamp && !Number.isNaN(Date.parse(m.timestamp)) ? shortDate(m.timestamp) : <span title="Saved before Rigour kept the date">not recorded</span>) },
                ]}
            />
            <div className="ui-card-body"><div className="mem-note">Agents recall these by meaning. They stay on this machine: <code>.rigour/memory.json</code> for this repository, <code>~/.rigour/memory.json</code> for you. A memory reaches teammates' agents only once a person shares it.</div></div>
        </Card>
    );
};

const EVIDENCE_WORDS: Record<string, string> = {
    point: 'raised it', outcome: 'a later fix or revert backed it', counter: 'the lines shipped unchanged and nothing needed fixing',
    correction: 'corrected what an agent wrote', accepted: 'promoted it', rejected: 'decided against it', 'not-a-rule': 'judged it not a rule',
    'took-back': 'took back the decision', norule: 'no rule found in it', followup: 'a later fix touched its file', lines: 'a later fix changed its lines',
    dismissed: 'set that evidence aside', against: 'a later PR repeated it and settled clean', demoted: 'evidence took it back',
    reclassified: 'back to a candidate', compiled: 'decided its compiled check', reworded: 'took the corrected wording', scoped: 'set how far it reaches',
};
/** Kinds a person (or a teammate) did, so the author is named; the rest are evidence Rigour read. */
const BY_PERSON = new Set(['point', 'correction', 'accepted', 'rejected', 'not-a-rule', 'took-back', 'dismissed', 'compiled', 'reworded', 'scoped']);

/** The pull request the evidence came from; a person's edit to an agent's code is recorded with no pull request (pr 0). */
function whereFrom(item: EvidenceItem): string {
    if (item.pr > 0) return `PR #${item.pr}`;
    return item.kind === 'correction' ? 'An edit after the agent' : 'Not from a pull request';
}

const EvidenceLine: React.FC<{ item: EvidenceItem }> = ({ item }) => (
    <div className="mem-trail-item">
        <span>{whereFrom(item)}{item.at ? ` · ${shortDate(item.at)}` : ''} · </span>
        {BY_PERSON.has(item.kind) && item.author ? <><strong>{item.author}</strong>{item.team ? ' (team)' : ''}{item.source === 'bot' ? ' (bot)' : ''} </> : null}
        {EVIDENCE_WORDS[item.kind] ?? item.kind}
        {item.detail ? <span>: {item.detail}</span> : null}
    </div>
);

const REVIEW_CAP = 60;

/** Lessons learned from pull request reviews, each with its trail: who said it, at which PR, who decided and why. */
export const FromReviews: React.FC<{ lessons: Journey[] }> = ({ lessons }) => {
    const review = lessons.filter(l => l.origin === 'pr');
    if (review.length === 0) {
        return <Empty>No lessons from pull request reviews yet. <code>rigour learn-reviews</code> reads the review comments on merged pull requests and turns each point into a candidate a person promotes or drops.</Empty>;
    }
    return (
        <div className="mem-list">
            {review.slice(0, REVIEW_CAP).map(l => (
                <Card key={l.id}>
                    <div className="mem-chips"><Chip tone={IN_FORCE.has(l.state) ? 'ok' : l.state === 'candidate' ? 'warn' : 'plain'}>{l.state}</Chip>{l.fromBots && <Chip>review bots only</Chip>}</div>
                    <div className="mem-lesson-text">{inlineCode(l.text)}</div>
                    {l.evidence?.length
                        ? <div className="mem-trail">{l.evidence.map((e, i) => <EvidenceLine key={`${i}-${e.kind}-${e.pr}`} item={e} />)}</div>
                        : <div className="mem-note">{l.learnedFrom}. Its evidence trail was not recorded.</div>}
                </Card>
            ))}
            {review.length > REVIEW_CAP && <div className="mem-note">and {review.length - REVIEW_CAP} more in <code>.rigour/review-lessons.json</code>.</div>}
        </div>
    );
};

/** Rules learned from agents' fixes, checked on every edit like a built-in check. */
export const LearnedRules: React.FC<{ rules: LearnedRule[] }> = ({ rules }) => (
    <Card title="Rules learned from fixes" meta="checked on every edit">
        {rules.length === 0
            ? <Empty>None yet. <code>rigour learn</code> turns an agent's fixes into rules once they hold up.</Empty>
            : rules.map(r => <div className="ui-item" key={r.id}><div>{r.message}</div><div className="mem-note">{r.requirement} · {r.appliesTo}</div></div>)}
    </Card>
);
