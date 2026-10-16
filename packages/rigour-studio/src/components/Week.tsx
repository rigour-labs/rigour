import React, { useState } from 'react';
import { LoadError, PageHeader, Skeleton } from './ui';
import { useStudioJson } from './storyData';
import { WeekView } from './WeekView';
import type { ProgressWeek, WeekData } from './WeekParts';

const INTRO_KEY = 'rigour-intro-hidden';

/** "This week": the opening screen. What Rigour stopped, what needs a person, and the stories behind the numbers. */
export const Week: React.FC<{ onNavigate: (tab: string) => void }> = ({ onNavigate }) => {
    const { data, error, reload } = useStudioJson<WeekData>('/api/week');
    const progress = useStudioJson<{ weeks: ProgressWeek[] }>('/api/progress');
    const [intro, setIntro] = useState(() => { try { return localStorage.getItem(INTRO_KEY) !== '1'; } catch { return true; } });
    const header = <PageHeader title="This week" />;
    if (error) return <div className="ui-page">{header}<LoadError what="this week" error={error} /></div>;
    if (!data) return <div className="ui-page">{header}<Skeleton label="Loading this week" /></div>;
    const hideIntro = () => { try { localStorage.setItem(INTRO_KEY, '1'); } catch { /* not remembered */ } setIntro(false); };
    return (
        <WeekView data={data} weeks={progress.data?.weeks ?? null} intro={intro} onHideIntro={hideIntro} onDone={reload} onNavigate={onNavigate} />
    );
};
