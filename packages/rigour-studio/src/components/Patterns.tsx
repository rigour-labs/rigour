import React from 'react';
import { useStudioJson } from './storyData';
import { Kpis, LoadError, PageHeader, Skeleton } from './ui';
import { IndexShape, IndexTable, RecurringTable, ReuseList, patternKpis, type PatternsData } from './PatternsParts';
import { AgentsGiven, WeeklyTable, type ContextData } from './PatternsContext';
import './patterns.css';

/** Patterns: what Rigour knows about this codebase, and what it handed agents. */
export const Patterns: React.FC = () => {
    const { data, error } = useStudioJson<PatternsData>('/api/patterns');
    const context = useStudioJson<ContextData>('/api/context');
    if (error) return <div className="ui-page"><PageHeader title="Patterns" /><LoadError what="patterns" error={error} /></div>;
    if (!data) return <div className="ui-page"><PageHeader title="Patterns" /><Skeleton label="Loading the function index" /></div>;
    return (
        <div className="ui-page">
            <PageHeader title="Patterns" lead="What Rigour knows about this codebase, and what it handed agents before they wrote: the functions that already exist, the problems that keep coming back, and the code agents were pointed to." />
            <Kpis items={patternKpis(data)} />
            <div className="ui-cols">
                <div className="ui-col">
                    <IndexTable index={data.index} />
                    <RecurringTable recurring={data.recurring} />
                    {context.error && <LoadError what="what agents were given" error={context.error} />}
                    {context.data && <><AgentsGiven data={context.data} /><WeeklyTable weeks={context.data.weeks} /></>}
                </div>
                <div className="ui-col">
                    <ReuseList reuse={data.reuse} />
                    <IndexShape index={data.index} />
                </div>
            </div>
        </div>
    );
};
