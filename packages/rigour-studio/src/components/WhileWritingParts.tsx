import React, { useState } from 'react';
import { Card, Chip, Empty, Kpis, Meter, Table, type Column, type KpiItem, type Tone } from './ui';
import { ago, inlineCode, plural, STAGE_WORDS, type CatchStage, type Story } from './storyData';
import { StoryCard } from './Week';
import './whileWriting.css';

interface FeedItem { at: string; stage: 'brief' | 'edit' | 'stop' | 'push' | 'fixed'; branch: string | null; agent: string | null; session: string | null; text: string; detail?: string; tone: Tone }
interface AgentRow { agent: string | null; briefings: number; editsChecked: number; editsWithFindings: number; stopReviews: number; sentBack: number; pushes: number | null }

export interface DevelopmentData {
    window: { from: string; to: string; days: number };
    recordingSince: string | null;
    stages: {
        brief: { briefings: number; sessions: number | null; told: number; onRequest: number };
        edits: { checked: number; withFindings: number; blocked: number | null };
        stop: { reviews: number; blocked: number; nothingToReview: number | null; fixedBeforeDone: number };
        push: { runs: number; passed: number; failed: number };
    };
    caught: { total: number; fixedByAgent: number; stillOpen: number; medianMinutesToFix: number | null; byStage: Record<CatchStage, number> };
    topRules: Array<{ rule: string; title: string; caught: number; fixed: number }>;
    byAgent: AgentRow[];
    recentFixes: Story[];
    open: Array<{ file: string; rule: string; title: string; openedAt: string; stage: CatchStage }>;
    feed: FeedItem[];
}

export interface SetupCheck { id: string; state: string; detail?: string; fix?: string }

/** What fills a stage when nothing ran: the setup step it needs, from Studio's setup checks where it has one. */
type StageHints = Partial<Record<'edit' | 'stop', string>>;

interface StageCard { key: string; step: string; title: string; value: number; unit: string; meaning: string; facts: string; empty: string }

/** The four moments an agent passes through on the way to a pull request, left to right. */
const StageFlow: React.FC<{ stages: DevelopmentData['stages']; hints: StageHints }> = ({ stages, hints }) => {
    const { brief, edits, stop, push } = stages;
    const cards: StageCard[] = [
        {
            key: 'brief', step: '1 · Before writing', title: 'Briefed', value: brief.briefings, unit: brief.briefings === 1 ? 'briefing' : 'briefings',
            meaning: "The team's rules and lessons for the files the agent was about to change.",
            facts: `${plural(brief.told, 'item')} told${brief.sessions === null ? '' : ` in ${plural(brief.sessions, 'session')}`} · ${plural(brief.onRequest, 'lesson')} the agent asked for itself`,
            empty: 'Agents are briefed when they call rigour_brief, or by themselves in Claude Code after `rigour hooks init --brief`.',
        },
        {
            key: 'edit', step: '2 · Each edit', title: 'Checked', value: edits.checked, unit: edits.checked === 1 ? 'edit' : 'edits',
            meaning: 'Every file the agent changed, checked as it was written.',
            facts: `${plural(edits.withFindings, 'edit')} with a finding · ${edits.blocked === null ? 'blocks not recorded' : `${edits.blocked} blocked`}`,
            empty: hints.edit ?? 'No edits were checked in this window. The edit hook comes with `rigour setup`.',
        },
        {
            key: 'stop', step: '3 · Agent said done', title: 'Reviewed', value: stop.reviews, unit: stop.reviews === 1 ? 'review' : 'reviews',
            meaning: 'When the agent said it was done, Rigour reviewed the work and sent it back if a problem remained.',
            facts: `${stop.blocked} sent back · ${plural(stop.fixedBeforeDone, 'problem')} fixed before it stopped`,
            empty: hints.stop ?? 'No agent said done in this window. The stop review comes with `rigour setup`.',
        },
        {
            key: 'push', step: '4 · Push', title: 'Push checks', value: push.runs, unit: push.runs === 1 ? 'push' : 'pushes',
            meaning: 'The checks ran once more before the code left the machine.',
            facts: `${push.passed} passed · ${push.failed} held`,
            empty: "No pushes checked in this window. `rigour hooks init` adds git's pre-push check.",
        },
    ];
    return (
        <div className="ww-flow">
            {cards.map(card => (
                <section className="ww-stage" key={card.key} aria-label={card.title}>
                    <span className="ww-stage-step">{card.step}</span>
                    <h3>{card.title}</h3>
                    <div className="ww-stage-value">{card.value}<span className="ww-stage-unit">{card.unit}</span></div>
                    <p>{card.meaning}</p>
                    <div className="ww-stage-facts">{card.value ? card.facts : inlineCode(card.empty)}</div>
                </section>
            ))}
        </div>
    );
};

/** Problems the agent fixed after Rigour reported them, each with the code change on request. */
const FixedList: React.FC<{ stories: Story[] }> = ({ stories }) => {
    const [open, setOpen] = useState<string | null>(null);
    if (stories.length === 0) return <Empty>When an agent fixes a problem Rigour reported while it was writing, it appears here with the code change.</Empty>;
    return <div className="st-stack">{stories.map(s => <StoryCard key={s.id} story={s} open={open === s.id} onToggle={() => setOpen(open === s.id ? null : s.id)} />)}</div>;
};

const STAGE_CHIP: Record<FeedItem['stage'], string> = { brief: 'briefed', edit: 'edit', stop: 'said done', push: 'push', fixed: 'fixed' };
/** A gap this long between two moments starts a new stretch of work. */
const SESSION_GAP_MS = 45 * 60 * 1000;

/** Feed items (newest first) in stretches of work: consecutive moments with no long gap between them. */
function groupFeed(items: FeedItem[]): FeedItem[][] {
    const groups: FeedItem[][] = [];
    for (const item of items) {
        const current = groups[groups.length - 1];
        const last = current?.[current.length - 1];
        if (last && Date.parse(last.at) - Date.parse(item.at) <= SESSION_GAP_MS) current.push(item);
        else groups.push([item]);
    }
    return groups;
}

const time = (at: string) => new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const day = (at: string) => new Date(at).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
const distinct = (values: Array<string | null>) => [...new Set(values.filter((v): v is string => !!v))];

const Feed: React.FC<{ items: FeedItem[] }> = ({ items }) => {
    if (items.length === 0) return <div className="ui-card-body"><Empty>Nothing happened in this window. Briefings, findings, reviews and pushes appear here as agents work.</Empty></div>;
    return <div>{groupFeed(items).map(group => <FeedGroup key={group[0].at} items={group} />)}</div>;
};

const FeedGroup: React.FC<{ items: FeedItem[] }> = ({ items }) => {
    const start = items[items.length - 1].at;
    const end = items[0].at;
    const branches = distinct(items.map(i => i.branch));
    const agents = distinct(items.map(i => i.agent));
    return (
        <div className="ww-session">
            <div className="ww-session-head">
                <strong>{day(start)}, {time(start)}{start !== end ? `–${time(end)}` : ''}</strong>
                <span>{[branches.length ? branches.join(', ') : '', agents.length ? agents.join(', ') : 'agent not recorded'].filter(Boolean).join(' · ')}</span>
            </div>
            {items.map((item, i) => (
                <div className="ww-item" key={`${item.at}-${i}`}>
                    <Chip tone={item.tone}>{STAGE_CHIP[item.stage]}</Chip>
                    <div>
                        <div>{inlineCode(item.text)}</div>
                        {item.detail && <div className="ww-item-detail">{inlineCode(item.detail)}</div>}
                    </div>
                    <span className="ww-time">{time(item.at)}</span>
                </div>
            ))}
        </div>
    );
};

const TopRules: React.FC<{ rules: DevelopmentData['topRules'] }> = ({ rules }) => {
    if (rules.length === 0) return <Empty>The checks that catch the most while agents write are listed here once something is caught.</Empty>;
    return (
        <>
            {rules.map(r => (
                <div className="ww-rule" key={r.rule}>
                    <div className="ww-rule-line"><span>{inlineCode(r.title)}</span><span>{r.fixed} of {r.caught} fixed</span></div>
                    <Meter share={r.caught ? r.fixed / r.caught : 0} />
                    <span className="ui-mono" style={{ color: 'var(--text-dim)' }}>{r.rule}</span>
                </div>
            ))}
            <div className="ww-note">Named by the latest problem each check reported.</div>
        </>
    );
};

/** `sub`: a part of the line above it. */
interface StageLine { label: string; sub?: boolean; value: (r: AgentRow) => React.ReactNode }

const AGENT_LINES: StageLine[] = [
    { label: 'Briefed', value: r => r.briefings },
    { label: 'Edits checked', value: r => r.editsChecked },
    { label: 'with a finding', sub: true, value: r => r.editsWithFindings },
    { label: 'Said done', value: r => r.stopReviews },
    { label: 'sent back', sub: true, value: r => r.sentBack },
    { label: 'Pushes', value: r => r.pushes ?? '—' },
];

/** Per agent, one column each, only where a hook recorded which one; the rest sit together as "not recorded". */
const AgentTable: React.FC<{ rows: AgentRow[] }> = ({ rows }) => {
    if (rows.length === 0) return <div className="ui-card-body"><Empty>Each agent's briefings, checked edits and reviews appear here once its hooks run.</Empty></div>;
    const columns: Column<StageLine>[] = [
        { label: '', cell: line => <span className={line.sub ? 'ww-sub-line' : undefined}>{line.label}</span> },
        ...rows.map(row => ({ label: row.agent ?? 'not recorded', cell: (line: StageLine) => line.value(row) })),
    ];
    return (
        <div className="ww-agents">
            <Table rows={AGENT_LINES} columns={columns} rowKey={line => line.label} />
            <div className="ui-card-body ww-note">
                Edit checks name the agent only in Cursor or when RIGOUR_AGENT_ID is set; the push check never does (—). Fixes are not tied to an agent.
            </div>
        </div>
    );
};

const OpenList: React.FC<{ open: DevelopmentData['open']; total: number }> = ({ open, total }) => {
    if (open.length === 0) return <Empty>Nothing caught in this window is still waiting. A problem stays here until the agent fixes it or someone marks it "not a bug".</Empty>;
    return (
        <>
            {open.map(o => (
                <div className="ui-item" key={`${o.rule}:${o.file}`}>
                    <div>{inlineCode(o.title)}</div>
                    <div className="ww-note"><span className="ui-mono">{o.file}</span> · caught {STAGE_WORDS[o.stage]} · {ago(o.openedAt)}</div>
                </div>
            ))}
            {total > open.length && <div className="ww-note">And {total - open.length} more on the This week page.</div>}
        </>
    );
};

export const WhileWritingBody: React.FC<{ data: DevelopmentData; hints: StageHints }> = ({ data, hints }) => (
    <>
        <Kpis items={kpis(data)} />
        <StageFlow stages={data.stages} hints={hints} />
        <div className="ui-cols">
            <div className="ui-col">
                <Card title="Fixed by the agent" meta="before any pull request">
                    <FixedList stories={data.recentFixes} />
                </Card>
                <Card title="What happened" meta="newest first; clean checks and empty briefings are counted, not listed" flush>
                    <Feed items={data.feed} />
                </Card>
            </div>
            <div className="ui-col">
                <Card title="Caught most often"><TopRules rules={data.topRules} /></Card>
                <Card title="By agent" flush><AgentTable rows={data.byAgent} /></Card>
                <Card title="Still open" meta={data.caught.stillOpen ? String(data.caught.stillOpen) : undefined}>
                    <OpenList open={data.open} total={data.caught.stillOpen} />
                </Card>
                <div className="ww-note">
                    {data.recordingSince ? `Recording since ${new Date(data.recordingSince).toLocaleDateString()}.` : 'Rigour has not recorded any agent work in this repository yet.'}
                </div>
            </div>
        </div>
    </>
);

function kpis(data: DevelopmentData): KpiItem[] {
    const { edits, stop } = data.stages;
    const { caught } = data;
    return [
        { label: 'Edits checked', value: edits.checked, note: `${plural(edits.withFindings, 'edit')} with a finding` },
        { label: 'Caught while writing', value: caught.total, note: `${caught.byStage.edit} at an edit · ${caught.byStage.stop} when it said done · ${caught.byStage.review} in its own review` },
        {
            label: 'Fixed by the agent', value: caught.fixedByAgent,
            note: caught.medianMinutesToFix === null ? 'time to fix not recorded' : `median ${duration(caught.medianMinutesToFix)} from report to fix`,
        },
        { label: 'Sent back at "done"', value: stop.blocked, note: `of ${plural(stop.reviews, 'time')} an agent said it was done` },
    ];
}

/** Minutes as a person says them: minutes up to two hours, then hours, then days. */
function duration(minutes: number): string {
    if (minutes < 1) return 'under a minute';
    if (minutes < 120) return plural(Math.round(minutes), 'minute');
    if (minutes < 48 * 60) return plural(Math.round(minutes / 60), 'hour');
    return plural(Math.round(minutes / (24 * 60)), 'day');
}

/** The setup step a stage needs when its hook is missing or broken, from Studio's own setup checks. */
export function stageHints(checks: SetupCheck[] | undefined): StageHints {
    const hint = (id: 'edit' | 'stop', what: string) => {
        const check = checks?.find(c => c.id === id);
        return check && (check.state === 'missing' || check.state === 'broken') ? `${what} is not set up in this repository${check.fix ? `: run \`${check.fix}\`` : ''}.` : undefined;
    };
    const edit = hint('edit', 'The edit check');
    const stop = hint('stop', 'The review when an agent says done');
    return { ...(edit ? { edit } : {}), ...(stop ? { stop } : {}) };
}
