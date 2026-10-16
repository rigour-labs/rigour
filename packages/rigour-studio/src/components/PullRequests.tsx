import React, { useState } from 'react';
import { useStudioJson } from './storyData';
import { LoadError, PageHeader, Skeleton, TabPanel, Tabs, usePersisted } from './ui';
import { BranchReview } from './Reviews';
import { PullView } from './PullDetail';
import { PullsKpiRow, PullsLead, PullsTable } from './PullsList';
import type { PullAnswer, PullRow, PullsList } from './pullsData';
import './pulls.css';

const TABS = [{ id: 'all', label: 'All pull requests' }, { id: 'branch', label: 'This branch, before its pull request' }];

/** Pull requests: each one from the first edit to the merge, and this branch's review before it has one. */
export const PullRequests: React.FC = () => {
    const [open, setOpen] = useState<string | null>(null);
    const [stored, setTab] = usePersisted<string>('pulls:tab', 'all');
    const tab = TABS.some(t => t.id === stored) ? stored : 'all';
    if (open) return <OnePull query={open} onBack={() => setOpen(null)} />;
    return (
        <div className="ui-page">
            <PageHeader title="Pull requests" lead={PullsLead} />
            <Tabs id="pulls" tabs={TABS} active={tab} onChange={setTab} />
            <TabPanel id="pulls" active={tab}>{tab === 'all' ? <AllPulls onOpen={row => setOpen(queryOf(row))} /> : <BranchReview />}</TabPanel>
        </div>
    );
};

const queryOf = (row: PullRow) => (row.pr !== null ? `n=${row.pr}` : `branch=${encodeURIComponent(row.branches[row.branches.length - 1] ?? '')}`);

const AllPulls: React.FC<{ onOpen: (row: PullRow) => void }> = ({ onOpen }) => {
    const { data, error } = useStudioJson<PullsList>('/api/pulls');
    if (error) return <LoadError what="pull requests" error={error} />;
    if (!data) return <Skeleton label="Loading pull requests" />;
    return (
        <>
            <PullsKpiRow list={data} />
            <PullsTable list={data} onOpen={onOpen} />
        </>
    );
};

const OnePull: React.FC<{ query: string; onBack: () => void }> = ({ query, onBack }) => {
    const { data, error } = useStudioJson<PullAnswer>(`/api/pull?${query}`);
    if (error) return <div className="ui-page"><LoadError what="this pull request" error={error} /></div>;
    if (!data) return <div className="ui-page"><Skeleton label="Loading this pull request" /></div>;
    return <PullView answer={data} onBack={onBack} />;
};
