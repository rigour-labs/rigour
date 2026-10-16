import React from 'react';
import { Empty, PageHeader } from './ui';
import { useStudioJson } from './storyData';
import { GovernanceView, GOVERNANCE_LEAD as LEAD } from './GovernanceView';
import type { GovernanceData } from './governanceData';

/** Governance: coverage, decisions, quality rules, reviewer usage and the team. */
export const Governance: React.FC<{ onNavigate?: (tab: string) => void }> = ({ onNavigate }) => {
    const { data, error } = useStudioJson<GovernanceData>('/api/governance');
    const header = <PageHeader title="Governance" lead={LEAD} />;
    if (error) return <div className="ui-page">{header}<Empty>Couldn't load governance: {error}.</Empty></div>;
    if (!data) return <div className="ui-page">{header}<div className="gov-dim">Loading…</div></div>;
    return <GovernanceView data={data} onSetup={() => onNavigate?.('setup')} />;
};
