/** The Pull requests list: the numbers for the last four weeks, then one row per pull request, newest activity first. */
import React from 'react';
import { ago, plural } from './storyData';
import { Card, Chip, Empty, Kpis, Pager, Table, usePaged, type Column, type KpiItem } from './ui';
import { ciWords, outcomeWords, prLabel, STATE_WORDS, type PullRow, type PullsList } from './pullsData';
import './pulls.css';

const NO_MERGES = 'No merge recorded here: run rigour outcomes to read merges from GitHub.';

function pullsKpis(list: PullsList): KpiItem[] {
    const w = list.window;
    return [
        { label: 'PRs reviewed', value: w.reviewed, note: `with a Rigour review in the last ${w.days} days` },
        { label: 'Blocking issues', value: w.reviewed ? w.blocking : '—', note: w.reviewed ? <span title="Distinct blocking items across review rounds, from the reviewer's records; a round without a record counts its own total.">found before merge</span> : 'shows once a pull request is reviewed' },
        { label: 'Lessons applied', value: w.reviewed ? w.lessonsApplied : '—', note: 'team lessons the review found repeated' },
        merged(list),
    ];
}

function merged(list: PullsList): KpiItem {
    const w = list.window;
    if (!list.mergesRecorded) return { label: 'Merged without revert', value: '—', note: NO_MERGES };
    if (w.merged === 0) return { label: 'Merged without revert', value: '—', note: `none of these merged yet, as recorded` };
    return { label: 'Merged without revert', value: `${w.mergedClean} of ${w.merged}`, note: 'reviewed pull requests that merged' };
}

const columns: Column<PullRow>[] = [
    { label: 'Pull request', wrap: true, cell: r => <PrCell row={r} /> },
    { label: 'State', cell: r => <span title={STATE_WORDS[r.state].note}><Chip tone={STATE_WORDS[r.state].tone}>{STATE_WORDS[r.state].label}</Chip></span> },
    { label: 'Last review', cell: r => <LastReview row={r} /> },
    { label: 'Rounds', num: true, secondary: true, cell: r => r.rounds || '—' },
    { label: 'Lessons applied', num: true, secondary: true, cell: r => (r.rounds ? r.lessonsApplied : '—') },
    { label: 'After merge', wrap: true, cell: r => <AfterMerge row={r} /> },
    { label: 'Last activity', secondary: true, cell: r => ago(r.lastActivity) },
];

/** CI on the merge and the follow-up fixes, as one cell; a dash with why where no merge is recorded. */
const AfterMerge: React.FC<{ row: PullRow }> = ({ row }) => {
    if (row.state === 'not-opened') return <span className="pulls-dim">—</span>;
    const fixes = row.followUps ? `${plural(row.followUps.fixes, 'fix', 'fixes')} later` : null;
    return (
        <span className="pulls-review" title={row.ci || row.followUps ? (row.followUps ? `${plural(row.followUps.commits, 'later commit')} on main touched its files` : undefined) : NO_MERGES}>
            <span>CI {ciWords(row.ci)}</span>{fixes && <span className="pulls-dim">{fixes}</span>}
        </span>
    );
};

const PrCell: React.FC<{ row: PullRow }> = ({ row }) => (
    <span className="pulls-pr">
        <strong className="pulls-name" title={row.title ?? undefined}>{prLabel(row)}{row.title && <span className="pulls-title"> {row.title}</span>}</strong>
        {row.pr !== null && <span className="ui-mono pulls-dim pulls-branch" title={row.branches.join(', ')}>{row.branches.join(', ')}</span>}
    </span>
);

const LastReview: React.FC<{ row: PullRow }> = ({ row }) => {
    const r = row.lastReview;
    if (!r) return <span className="pulls-dim">no review recorded</span>;
    const words = outcomeWords(r.outcome);
    return (
        <span className="pulls-review">
            <Chip tone={words.tone}>{words.label}</Chip>
            <span className="pulls-dim">{r.blocking} blocking · {r.shouldFix} should fix</span>
        </span>
    );
};

export const PullsTable: React.FC<{ list: PullsList; onOpen: (row: PullRow) => void }> = ({ list, onOpen }) => {
    const paged = usePaged(list.rows, { storageKey: 'pulls:list' });
    return (
        <Card title="Every pull request Rigour saw" meta={list.rows.length ? `${plural(list.rows.length, 'row')} · click one to walk its timeline` : undefined} flush>
            {list.rows.length === 0
                ? <div className="ui-card-body"><Empty>{list.scope.older ? `No pull request with activity in the last ${list.scope.days} days.` : 'No pull request recorded on this machine yet.'} A row appears when Rigour reviews a branch: turn the reviewer on in Setup, or run <span className="ui-mono">rigour review --reviewer</span> on a branch.</Empty></div>
                : <Table rows={paged.items} columns={columns} rowKey={r => r.key} onRow={onOpen} />}
            <Pager paged={paged} label="pull requests" />
            {list.scope.older > 0 && <div className="ui-card-body pulls-dim"><small>Showing branches with activity in the last {list.scope.days} days; {plural(list.scope.older, 'quieter branch', 'quieter branches')} left out.</small></div>}
        </Card>
    );
};

export const PullsLead = 'For each pull request, what happened from the first edit to the merge, and what Rigour\'s review added. Read from this machine\'s records.';

export const PullsKpiRow: React.FC<{ list: PullsList }> = ({ list }) => <Kpis items={pullsKpis(list)} />;
