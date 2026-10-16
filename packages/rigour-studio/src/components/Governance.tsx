import React from 'react';
import { LoadError, PageHeader, Skeleton } from './ui';
import { useStudioJson } from './storyData';
import { GovernanceView, GOVERNANCE_LEAD as LEAD } from './GovernanceView';
import type { GovernanceData } from './governanceData';

/** Governance: coverage, decisions, quality rules, reviewer usage and the team. */
export const Governance: React.FC<{ onNavigate?: (tab: string) => void }> = ({ onNavigate }) => {
    const { data, error } = useStudioJson<GovernanceData>('/api/governance');
    const header = <PageHeader title="Governance" lead={LEAD} />;
    if (error) return <div className="ui-page">{header}<LoadError what="governance" error={error} /></div>;
    if (!data) return <div className="ui-page">{header}<Skeleton label="Loading governance" /></div>;
    return <GovernanceView data={data} onSetup={() => onNavigate?.('setup')} />;
};
