import React from 'react';
import { LoadError, PageHeader, Skeleton, usePersisted } from './ui';
import { useStudioJson } from './storyData';
import { stageHints, WhileWritingBody, type DevelopmentData, type SetupCheck } from './WhileWritingParts';
import './story.css';
import './whileWriting.css';

const WINDOWS = [7, 28] as const;

/** While writing: what Rigour did while agents wrote code, before any pull request. */
export const WhileWriting: React.FC = () => {
    const [stored, setDays] = usePersisted<number>('writing:days', 7);
    const days = stored === 28 ? 28 : 7;
    const { data, error } = useStudioJson<DevelopmentData>(`/api/development?days=${days}`);
    const setup = useStudioJson<{ checks: SetupCheck[] }>('/api/setup').data;
    const toggle = (
        <div className="ww-toggle" role="group" aria-label="Time window">
            {WINDOWS.map(d => <button key={d} type="button" className={d === days ? 'on' : ''} aria-pressed={d === days} onClick={() => setDays(d)}>{d === 7 ? 'Last 7 days' : 'Last 28 days'}</button>)}
        </div>
    );
    return (
        <div className="ui-page">
            <PageHeader title="While writing" lead="What Rigour did while agents wrote code, before any pull request: briefed them, checked each edit, reviewed their work when they said done, and checked the push." aside={toggle} />
            {error && <LoadError what="what happened while writing" error={error} />}
            {!error && !data && <Skeleton label="Loading what happened while writing" />}
            {data && <WhileWritingBody data={data} hints={stageHints(setup?.checks)} />}
        </div>
    );
};
