/** The Memory page's tabs and numbers: what is in force, what agents were told, what was remembered, and review evidence. Learning.tsx loads the data. */
import React from 'react';
import { ago, plural } from './storyData';
import { Card, Chip, Clamp, Empty, FilterBar, MemoryText, Pager, StateChip, WeekChart, matchesQuery, usePaged, usePersisted, type KpiItem } from './ui';
import type { EvidenceItem, Journey } from './LearningParts';
import { lessonBuckets, lessonSearchText, lessonState, originNote, timesTold } from './lessonWords';
import './memory.css';

export interface LearningWeek { from: string; stoppedInDevelopment: number; reachedPr: number | null }
export interface Briefed { lessons: number; requests: number; days: number }
export interface Memory { value: string; timestamp?: string; source?: string }
export interface LearnedRule { id: string; message: string; requirement: string; appliesTo: string }

/** The page's four numbers. Repeats stopped is computed, and says so. */
export function memoryKpis(lessons: Journey[], weeks: LearningWeek[], briefed?: Briefed): KpiItem[] {
    // Counted through the same piles as the list's filter chips (bots' candidates apart, as the list hides them).
    const people = lessons.filter(l => !l.fromBots);
    const waiting = people.filter(l => lessonBuckets(l).has('waiting')).length;
    const bots = lessons.filter(l => l.fromBots && lessonBuckets(l).has('waiting')).length;
    return [
        { label: 'Lessons in force', value: people.filter(l => lessonBuckets(l).has('force')).length, note: 'Kept by a person or by evidence; agents are given these.' },
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

/** Repeats of a learned mistake, by week: stopped in development, and reaching a PR where branch reviews run here. A quiet month is one line. */
export const RepeatsCard: React.FC<{ weeks: LearningWeek[]; prRecorded: boolean }> = ({ weeks, prRecorded }) => {
    if (weeks.every(w => w.stoppedInDevelopment + (w.reachedPr ?? 0) === 0)) {
        return <div className="mem-note">Repeat mistakes, by week: no learned mistake came back in the last {plural(weeks.length, 'week')}. When an agent is about to repeat one, it is counted here.</div>;
    }
    const series = [{ label: 'stopped in development', color: 'var(--accent-primary)' }, ...(prRecorded ? [{ label: 'reached a PR', color: 'var(--status-warning)' }] : [])];
    const bars = weeks.map(w => ({ label: new Date(w.from).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }), values: [w.stoppedInDevelopment, ...(prRecorded ? [w.reachedPr ?? 0] : [])] }));
    return (
        <Card title="Repeat mistakes, by week" meta="computed from the lesson's rule and title">
            <WeekChart weeks={bars} series={series} />
            {!prRecorded && <div className="mem-note">Repeats that reached a PR show once branch reviews run on this machine (<code>rigour review --base main</code>, for example in a pre-push hook). Reviews in CI stay in CI.</div>}
        </Card>
    );
};

const WHERE: Record<string, string> = { project: 'this repository', global: 'you, every repository' };

const savedOn = (m: Memory) => (m.timestamp && !Number.isNaN(Date.parse(m.timestamp)) ? `saved ${ago(m.timestamp)}` : 'saved: not recorded');
const bareKey = (key: string) => key.replace(/^(project|global):/, '');
type Where = 'all' | 'project' | 'global';

/** Facts agents were told to remember, with where each is kept and when it was saved; searchable, 25 to a page. */
export const RememberedTable: React.FC<{ memories: Array<[string, Memory]> }> = ({ memories }) => {
    const [query, setQuery] = React.useState('');
    const [stored, setWhere] = usePersisted<string>('memory:remembered:where', 'all');
    const where: Where = stored === 'project' || stored === 'global' ? stored : 'all';
    const sorted = React.useMemo(() => [...memories].sort((a, b) => (b[1].timestamp ?? '').localeCompare(a[1].timestamp ?? '')), [memories]);
    const shown = sorted.filter(([key, m]) => (where === 'all' || m.source === where) && matchesQuery(`${key} ${m.value}`, query));
    const paged = usePaged(shown, { resetKey: `${where}\u0000${query}`, storageKey: 'memory:remembered' });
    if (memories.length === 0) {
        return <Empty>Nothing remembered yet. When you tell an agent to remember something, it saves it with the <code>rigour_remember</code> tool, and it shows here with where it is kept and when it was saved.</Empty>;
    }
    const chips = [
        { id: 'all', label: 'All', count: memories.length },
        { id: 'project', label: 'This repository', count: memories.filter(([, m]) => m.source === 'project').length },
        { id: 'global', label: 'You, every repository', count: memories.filter(([, m]) => m.source === 'global').length },
    ];
    return (
        <Card title="What agents were told to remember" meta="newest first" flush>
            <div className="ui-card-body">
                <FilterBar query={query} onQuery={setQuery} placeholder="Search remembered facts by key or text" chips={chips} active={where} onChip={id => setWhere(id)} matching={shown.length} noun={['fact', 'facts']} />
            </div>
            {shown.length === 0
                ? <div className="ui-card-body"><Empty>No remembered fact matches “{query}”.</Empty></div>
                : (
                    <div className="ui-list">
                        {paged.items.map(([key, m]) => (
                            <div className="ui-list-row" key={key}>
                                <MemoryText text={m.value} memoryKey={bareKey(key)} value={m.value} />
                                <span className="ui-meta">kept for {WHERE[m.source ?? ''] ?? 'a place not recorded'} · {savedOn(m)}</span>
                            </div>
                        ))}
                    </div>
                )}
            <Pager paged={paged} label="remembered facts" />
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
        <span>{whereFrom(item)}{item.at ? ` · ${ago(item.at)}` : ''} · </span>
        {BY_PERSON.has(item.kind) && item.author ? <><strong>{item.author}</strong>{item.team ? ' (team)' : ''}{item.source === 'bot' ? ' (bot)' : ''} </> : null}
        {EVIDENCE_WORDS[item.kind] ?? item.kind}
        {item.detail ? <span>: {item.detail}</span> : null}
    </div>
);

const TRAIL_SHOWN = 4;

/** A review lesson's evidence, the first four lines and the rest on request. */
const Trail: React.FC<{ items: EvidenceItem[] }> = ({ items }) => {
    const [all, setAll] = React.useState(false);
    const shown = all ? items : items.slice(0, TRAIL_SHOWN);
    return (
        <div className="mem-trail">
            {shown.map((e, i) => <EvidenceLine key={`${i}-${e.kind}-${e.pr}`} item={e} />)}
            {items.length > TRAIL_SHOWN && <button type="button" className="ui-clamp-toggle" aria-expanded={all} onClick={() => setAll(!all)}>{all ? 'Show less' : `Show all ${items.length}`}</button>}
        </div>
    );
};

/** Lessons learned from pull request reviews, each with its trail: who said it, at which PR, who decided and why. */
export const FromReviews: React.FC<{ lessons: Journey[] }> = ({ lessons }) => {
    const [query, setQuery] = React.useState('');
    const review = lessons.filter(l => l.origin === 'pr');
    const shown = review.filter(l => matchesQuery(`${lessonSearchText(l)} ${(l.evidence ?? []).map(e => `${e.author} #${e.pr}`).join(' ')}`, query));
    const paged = usePaged(shown, { resetKey: query, storageKey: 'memory:reviews' });
    if (review.length === 0) {
        return <Empty>No lessons from pull request reviews yet. <code>rigour learn-reviews</code> reads the review comments on merged pull requests and turns each point into a candidate a person promotes or drops.</Empty>;
    }
    return (
        <Card title="Learned from pull request reviews" meta="newest first" flush>
            <div className="ui-card-body">
                <FilterBar query={query} onQuery={setQuery} placeholder="Search review lessons by text, reviewer or PR" matching={shown.length} noun={['lesson', 'lessons']} />
            </div>
            {shown.length === 0
                ? <div className="ui-card-body"><Empty>No review lesson matches “{query}”.</Empty></div>
                : (
                    <div className="ui-list">
                        {paged.items.map(l => (
                            <div className="ui-list-row" key={l.id}>
                                <div className="mem-row-head">
                                    <MemoryText text={l.text} />
                                    <div className="mem-chips"><StateChip state={lessonState(l)} />{l.fromBots && <Chip>review bots only</Chip>}</div>
                                </div>
                                {l.evidence?.length ? <Trail items={l.evidence} /> : <div className="ui-meta">{originNote(l)}. Its evidence trail was not recorded.</div>}
                                <span className="ui-meta">Agents told: {timesTold(l.told)}</span>
                            </div>
                        ))}
                    </div>
                )}
            <Pager paged={paged} label="review lessons" />
        </Card>
    );
};

/** Rules learned from agents' fixes, checked on every edit like a built-in check. */
export const LearnedRules: React.FC<{ rules: LearnedRule[] }> = ({ rules }) => {
    const [query, setQuery] = React.useState('');
    const shown = rules.filter(r => matchesQuery(`${r.message} ${r.requirement} ${r.appliesTo}`, query));
    const paged = usePaged(shown, { resetKey: query, storageKey: 'memory:rules' });
    if (rules.length === 0) {
        return <Card title="Rules learned from fixes" meta="checked on every edit"><Empty>None yet. <code>rigour learn</code> turns an agent's fixes into rules once they hold up.</Empty></Card>;
    }
    return (
        <Card title="Rules learned from fixes" meta={`${plural(rules.length, 'rule')} · checked on every edit`} flush>
            {rules.length > 5 && <div className="ui-card-body"><FilterBar query={query} onQuery={setQuery} placeholder="Search rules" matching={shown.length} noun={['rule', 'rules']} /></div>}
            <div className="ui-list">
                {paged.items.map(r => (
                    <div className="ui-list-row" key={r.id}>
                        <Clamp text={r.message} />
                        <span className="ui-meta">{r.requirement} · {r.appliesTo}</span>
                    </div>
                ))}
            </div>
            <Pager paged={paged} label="rules" />
        </Card>
    );
};
