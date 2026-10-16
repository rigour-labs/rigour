import React, { useState } from 'react';
import { HowItWorks } from './HowItWorks';
import { groupNeeds, NeedGroupCard, needsHeading } from './NeedGroups';
import { Card, Empty, Kpis, PageHeader, type KpiItem } from './ui';
import { plural, useStudioJson } from './storyData';
import { CopySummary, Recheck, RecentPullsCard, RepeatsChart, SetupGaps, StoryCard, type ProgressWeek, type WeekData } from './WeekParts';
import type { PullsList } from './pullsData';
import './story.css';
import './week.css';

/** "This week" drawn from its data: the numbers it leads with, the 8-week chart, what needs a person, and the stories. */
export const WeekView: React.FC<{
    data: WeekData;
    weeks: ProgressWeek[] | null;
    intro: boolean;
    onHideIntro: () => void;
    onDone: () => void;
    onNavigate: (tab: string) => void;
}> = ({ data, weeks, intro, onHideIntro, onDone, onNavigate }) => (
    <div className="ui-page">
        {intro && <HowItWorks onHide={onHideIntro} />}
        <PageHeader title="This week" lead={weekLead(data)} aside={<CopySummary data={data} />} />
        <Kpis items={weekKpis(data, weeks)} />
        <div className="ui-cols">
            <div className="ui-col">
                {weeks && <RepeatsChart weeks={weeks} />}
                <NeedsCard data={data} onDone={onDone} />
                <StoriesCard data={data} />
            </div>
            <div className="ui-col">
                <SetupGaps onSetup={() => onNavigate('setup')} />
                <RecentPulls onOpen={() => onNavigate('pulls')} />
                <Card title="Is it noisy?">
                    <span>{data.raised === 0 ? 'Nothing raised this week.' : `Rigour raised ${plural(data.raised, 'problem')} this week. You overruled ${data.overruled}.`}</span>
                    <small className="st-sub">Say "not a bug" once and Rigour stops raising it.</small>
                    <button className="ui-link" onClick={() => onNavigate('learns')} type="button">See how it learns</button>
                </Card>
                {data.recordingSince && <small className="st-sub">Recording since {new Date(data.recordingSince).toLocaleDateString()}</small>}
            </div>
        </div>
    </div>
);

function weekLead(data: WeekData): string {
    if (data.stopped.total > 0) return `${plural(data.stopped.total, 'problem')} stopped before a pull request this week, ${data.stopped.fixed} fixed so far.`;
    return data.recordingSince ? 'Nothing was stopped this week.' : 'Rigour has not recorded any agent work in this repository yet.';
}

function weekKpis(data: WeekData, weeks: ProgressWeek[] | null): KpiItem[] {
    const thisWeek = weeks?.[weeks.length - 1];
    const { edit, review, stop } = data.stopped.byStage;
    return [
        { label: 'Stopped before a PR', value: data.stopped.total, note: `${edit} while writing · ${review} on review · ${stop} before done` },
        { label: 'Fixed by the agent', value: data.stopped.fixed, note: data.stopped.total ? `of ${data.stopped.total} stopped` : 'nothing stopped yet' },
        { label: 'Repeats prevented', value: thisWeek ? thisWeek.repeatsStopped : '—', note: thisWeek ? 'computed: matches a lesson learned before' : 'not loaded' },
        { label: 'Reviews run', value: typeof data.reviews === 'number' ? data.reviews : '—', note: typeof data.reviews === 'number' ? 'model reviews this week' : 'no model review recorded here' },
        { label: 'Needs you', value: data.needs.length, note: data.needs.length ? 'open findings below' : 'nothing open' },
    ];
}

const NeedsCard: React.FC<{ data: WeekData; onDone: () => void }> = ({ data, onDone }) => {
    const groups = groupNeeds(data.needs);
    return (
        <Card title={needsHeading(groups)}>
            {groups.length === 0
                ? <Empty>When Rigour finds something an agent left open, it waits here for a person: copy it to your agent, or say it is not a bug.</Empty>
                : <>
                    <Recheck onDone={onDone} />
                    <div className="week-stack">{groups.map(g => <NeedGroupCard key={`${g.rule}:${g.pattern}`} group={g} onDone={onDone} />)}</div>
                </>}
        </Card>
    );
};

const StoriesCard: React.FC<{ data: WeekData }> = ({ data }) => {
    const [open, setOpen] = useState<string | null>(null);
    return (
        <Card title="What Rigour stopped this week" meta={data.stories.length ? plural(data.stories.length, 'story', 'stories') : undefined}>
            {data.stories.length === 0
                ? <Empty>When an agent fixes something Rigour caught, it appears here with the code change.</Empty>
                : <div className="week-stack">{data.stories.map(s => <StoryCard key={s.id} story={s} open={open === s.id} onToggle={() => setOpen(open === s.id ? null : s.id)} />)}</div>}
        </Card>
    );
};

/** The last few pull requests Rigour reviewed; nothing at all where this Studio has no such list. */
const RecentPulls: React.FC<{ onOpen: () => void }> = ({ onOpen }) => {
    const { data, error } = useStudioJson<PullsList>('/api/pulls');
    if (error || !data) return null;
    return <RecentPullsCard rows={data.rows} onOpen={onOpen} />;
};
