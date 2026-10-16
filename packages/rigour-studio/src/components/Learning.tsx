import React from 'react';
import { studioWrite } from '../studioWrite';
import { useStudioJson } from './storyData';
import { Empty, Kpis, PageHeader, TabPanel, Tabs } from './ui';
import { BotPointsToggle, CompiledChecks, LessonCard, OutcomeCard, type CompiledCheck, type Journey, type OutcomeNumbers } from './LearningParts';
import { FromReviews, LearnedRules, RememberedTable, RepeatsCard, memoryKpis, type Briefed, type LearnedRule, type LearningWeek, type Memory } from './MemoryParts';
import { HowMemoryWorks, JourneyCard } from './MemoryStore';
import './story.css';
import './memory.css';

interface LearningData {
    lessons: Journey[];
    weeks: LearningWeek[];
    prRecorded: boolean;
    outcomes?: OutcomeNumbers;
    compiled?: CompiledCheck[];
    briefed?: Briefed;
}

type ReviewDecision = 'accepted' | 'rejected' | 'dismissed' | 'not-a-rule' | 'took-back' | 'reworded';

/** The decisions a person makes on this page, each through an existing Studio write; the page reloads after one. */
function useLessonActions(reload: () => void) {
    const send = async (url: string, body: unknown, alertOnError = false) => {
        const res = await studioWrite(url, 'POST', JSON.stringify(body));
        if (res.ok) reload();
        else if (alertOnError) window.alert((await res.json().catch(() => ({}))).error ?? 'Could not record the decision.');
    };
    return {
        decide: (id: string, state: 'validated' | 'promoted' | 'rejected') => send('/api/lessons', { id, state }),
        decideReview: (id: string, decision: ReviewDecision) => send('/api/review-lessons', { id, decision }),
        scope: (id: string, to: 'file' | 'folder' | 'repo') => send('/api/review-lessons', { id, decision: 'scope', to }, true),
        decideCheck: (id: string, state: 'active' | 'withdrawn') => send('/api/compiled-checks', { id, state }, true),
        propose: () => send('/api/compiled-checks', { propose: true }),
    };
}

const TABS = [
    { id: 'lessons', label: 'Lessons' },
    { id: 'remembered', label: 'Remembered' },
    { id: 'reviews', label: 'From reviews' },
    { id: 'rules', label: 'Rules' },
];

interface TabProps { tab: string; data: LearningData; lessons: Journey[]; memories: Array<[string, Memory]>; rules: LearnedRule[]; actions: ReturnType<typeof useLessonActions>; botToggle: React.ReactNode }

/** The open tab's content. */
const LearningTab: React.FC<TabProps> = ({ tab, data, lessons, memories, rules, actions, botToggle }) => {
    if (tab === 'remembered') return <RememberedTable memories={memories} />;
    if (tab === 'reviews') return <><FromReviews lessons={lessons} />{botToggle}</>;
    if (tab === 'rules') return <><LearnedRules rules={rules} /><CompiledChecks checks={data.compiled ?? []} onDecide={actions.decideCheck} onPropose={actions.propose} /></>;
    return (
        <>
            <RepeatsCard weeks={data.weeks} prRecorded={data.prRecorded} />
            {data.lessons.length === 0
                ? <Empty>No lessons yet. They form when an agent fixes something Rigour reported, when a PR comment leads to a fix, or when you tell your agent to remember something.</Empty>
                : <div className="mem-list">{lessons.map(l => <LessonCard key={l.id} lesson={l} onDecide={actions.decide} onDecideReview={actions.decideReview} onScope={actions.scope} />)}</div>}
            {botToggle}
            {data.outcomes && <OutcomeCard numbers={data.outcomes} />}
        </>
    );
};

/** Memory: what Rigour has learned and remembered for this team, where each item came from, and whether it is working. */
export const Learning: React.FC = () => {
    const { data, error, reload } = useStudioJson<LearningData>('/api/learning');
    const memories = Object.entries(useStudioJson<{ memories: Record<string, Memory> }>('/api/memory').data?.memories ?? {});
    const rules = useStudioJson<LearnedRule[]>('/api/learned-rules').data ?? [];
    const [tab, setTab] = React.useState('lessons');
    const [showBots, setShowBots] = React.useState(false);
    const actions = useLessonActions(reload);
    if (error) return <div className="ui-page"><Empty>Couldn't load lessons: {error}.</Empty></div>;
    if (!data) return <div className="ui-page"><div className="mem-note">Loading…</div></div>;
    const lessons = showBots ? data.lessons : data.lessons.filter(l => !l.fromBots);
    const fromBots = data.lessons.filter(l => l.fromBots).length;
    const botToggle = fromBots > 0 && <BotPointsToggle count={fromBots} shown={showBots} onToggle={() => setShowBots(!showBots)} />;
    return (
        <div className="ui-page">
            <PageHeader title="Memory" lead="What Rigour has learned and remembered for this team, where each item came from, and whether it is working." />
            <Kpis items={memoryKpis(data.lessons, data.weeks, data.briefed)} />
            <div className="ui-cols">
                <div className="ui-col">
                    <Tabs id="memory" tabs={TABS} active={tab} onChange={setTab} />
                    <TabPanel id="memory" active={tab}>
                        <LearningTab tab={tab} data={data} lessons={lessons} memories={memories} rules={rules} actions={actions} botToggle={botToggle} />
                    </TabPanel>
                </div>
                <div className="ui-col">
                    <JourneyCard lessons={data.lessons} />
                    <HowMemoryWorks lessons={data.lessons} memories={memories} />
                </div>
            </div>
        </div>
    );
};
