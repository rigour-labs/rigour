import React from 'react';
import { Kpis, PageHeader, type KpiItem } from './ui';
import { CoverageCard, DecisionsCard } from './GovernanceParts';
import { QualityGatesCard, ReviewerUsageCard, TeamCard } from './GovernanceSide';
import type { GovernanceData } from './governanceData';
import './governance.css';

export const GOVERNANCE_LEAD = 'Is every agent covered, which rules hold, who decided what and why, and what review used. Read from what Rigour recorded on this machine.';

/** The Governance page drawn from its data: the numbers it leads with, coverage and decisions, then rules, review use and the team. */
export const GovernanceView: React.FC<{ data: GovernanceData; onSetup: () => void }> = ({ data, onSetup }) => (
    <div className="ui-page">
        <PageHeader title="Governance" lead={GOVERNANCE_LEAD} />
        <Kpis items={governanceKpis(data)} />
        <div className="ui-cols">
            <div className="ui-col">
                <CoverageCard coverage={data.coverage} fixes={data.fixes} onSetup={onSetup} />
                <DecisionsCard decisions={data.decisions} />
            </div>
            <div className="ui-col">
                <QualityGatesCard gates={data.qualityGates} />
                <ReviewerUsageCard usage={data.reviewer} />
                <TeamCard team={data.team} />
            </div>
        </div>
    </div>
);

function governanceKpis(data: GovernanceData): KpiItem[] {
    const agents = data.coverage.rows.length;
    return [
        {
            label: 'Moments covered',
            value: data.coverage.possible ? `${data.coverage.covered}/${data.coverage.possible}` : '—',
            note: data.coverage.possible ? `switched on, across ${agents} agent${agents === 1 ? '' : 's'}` : 'no agent hooks found here',
        },
        { label: 'Decisions, 28 days', value: data.decisionsRecent, note: 'by people, from every decision Rigour keeps' },
        {
            label: 'Review runs, 28 days',
            value: data.reviewer.days.length ? data.reviewer.runs : '—',
            note: data.reviewer.days.length ? 'model reviewer runs on this repository' : 'no reviewer run recorded here',
        },
        scoreKpi(data.qualityGates.score),
    ];
}

/** The latest quality score and its change over the scores shown; a dash before the first check. */
function scoreKpi(score: GovernanceData['qualityGates']['score']): KpiItem {
    if (score.length === 0) return { label: 'Quality score', value: '—', note: 'not recorded: rigour check records it' };
    const last = score[score.length - 1].score;
    if (score.length === 1) return { label: 'Quality score', value: last, note: 'one check recorded' };
    const change = last - score[0].score;
    return { label: 'Quality score', value: last, note: `${change >= 0 ? '+' : ''}${change} over the last ${score.length} checks` };
}
