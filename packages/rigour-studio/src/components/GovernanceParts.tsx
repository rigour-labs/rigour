import React, { useState } from 'react';
import { Card, Chip, Empty, Table, type Column, type Tone } from './ui';
import { ago, inlineCode } from './storyData';
import { STAGE_LABELS, type Configured, type Coverage, type CoverageCell, type CoverageRow, type Decision, type Stage } from './governanceData';

const CONFIGURED: Record<Configured, { tone: Tone; word: string }> = {
    on: { tone: 'ok', word: 'on' },
    off: { tone: 'warn', word: 'off' },
    broken: { tone: 'bad', word: 'broken' },
    'not checked': { tone: 'plain', word: 'not checked' },
    'no hooks': { tone: 'plain', word: 'no hooks' },
};

/** One agent × moment: whether it is switched on, and when Rigour last saw it fire here. */
const Cell: React.FC<{ cell: CoverageCell; stage: Stage }> = ({ cell, stage }) => {
    const shown = cell.configured ? CONFIGURED[cell.configured] : null;
    // The push gate and the reviewer act for whoever pushed: their sightings are in the "agent not recorded" row.
    const repoWide = stage === 'push' || stage === 'pr';
    return (
        <div className="gov-cell">
            {shown ? <Chip tone={shown.tone}>{shown.word}</Chip> : <span className="gov-dim">—</span>}
            <small>{cell.seen ? `seen ${ago(cell.seen)}` : repoWide ? 'every agent' : 'not seen in 28 days'}</small>
        </div>
    );
};

const Seen: React.FC<{ at: string | null }> = ({ at }) => <small className="gov-dim">{at ? `seen ${ago(at)}` : '—'}</small>;

/** Which agents run which of Rigour's moments here, and what to run where one is missing. */
export const CoverageCard: React.FC<{ coverage: Coverage; fixes: Array<{ name: string; fix: string }>; onSetup: () => void }> = ({ coverage, fixes, onSetup }) => {
    const anyUnattributed = coverage.stages.some(s => coverage.unattributed[s]);
    const rows: Array<CoverageRow | 'unattributed'> = [...coverage.rows, ...(anyUnattributed ? ['unattributed' as const] : [])];
    const columns: Column<CoverageRow | 'unattributed'>[] = [
        { label: 'Agent', wrap: true, cell: r => (r === 'unattributed'
            ? <div className="gov-agent"><strong>Agent not recorded</strong><div className="gov-note">The hook or gate did not say which agent ran it.</div></div>
            : <div className="gov-agent"><strong>{r.agent}</strong>{r.note && <div className="gov-note">{r.note}</div>}</div>) },
        ...coverage.stages.map(stage => ({
            label: STAGE_LABELS[stage],
            cell: (r: CoverageRow | 'unattributed') => (r === 'unattributed' ? <Seen at={coverage.unattributed[stage]} /> : <Cell cell={r.cells[stage]} stage={stage} />),
        })),
    ];
    return (
        <Card title="Is every agent covered?" meta="last 28 days" flush>
            {coverage.rows.length === 0
                ? <div className="ui-card-body"><Empty>No agent hooks were found here. <span className="ui-mono">rigour setup</span> adds them for Claude Code, Cursor, Windsurf and Cline; Codex has no hooks, so only the push gate and the reviewer reach it.</Empty></div>
                : <Table rows={rows} columns={columns} rowKey={r => (r === 'unattributed' ? '~unattributed' : r.agent)} />}
            <div className="ui-card-body gov-foot">
                <span className="gov-note">"Not checked": setup does not read the brief hook. "Seen" comes from what the hooks recorded on this machine.</span>
                {fixes.length > 0 && (
                    <div className="gov-fixes">
                        {fixes.map(f => <div key={f.name}><span>{f.name}</span><code className="ui-mono">{f.fix}</code></div>)}
                    </div>
                )}
                <button type="button" className="ui-link" onClick={onSetup}>Open Setup to fix what is off</button>
            </div>
        </Card>
    );
};

/** Every decision people made about Rigour here, newest first, filtered by kind. */
export const DecisionsCard: React.FC<{ decisions: Decision[] }> = ({ decisions }) => {
    const [kind, setKind] = useState<string | null>(null);
    const counts = new Map<string, number>();
    for (const d of decisions) counts.set(d.kind, (counts.get(d.kind) ?? 0) + 1);
    const shown = kind ? decisions.filter(d => d.kind === kind) : decisions;
    return (
        <Card title="Who decided what, and why" meta={decisions.length ? `newest ${decisions.length}` : undefined}>
            {decisions.length === 0
                ? <Empty>No decisions recorded yet. They appear when someone marks a finding "not a bug", accepts or rejects a lesson (<span className="ui-mono">rigour learn-reviews --promote</span> or <span className="ui-mono">--reject</span>), approves a compiled check, or answers an agent's request in Studio.</Empty>
                : (
                    <>
                        <div className="gov-filters" role="group" aria-label="Filter by kind">
                            <button type="button" className={kind === null ? 'on' : ''} aria-pressed={kind === null} onClick={() => setKind(null)}>All {decisions.length}</button>
                            {[...counts].map(([k, n]) => <button type="button" key={k} className={kind === k ? 'on' : ''} aria-pressed={kind === k} onClick={() => setKind(k)}>{k} {n}</button>)}
                        </div>
                        <div className="gov-log">{shown.map((d, i) => <DecisionRow key={`${d.at}:${i}`} decision={d} />)}</div>
                    </>
                )}
        </Card>
    );
};

const DecisionRow: React.FC<{ decision: Decision }> = ({ decision: d }) => (
    <div className="gov-decision">
        <div className="gov-decision-head">
            <Chip tone={/rejected|withdrawn|not a bug|dismissed|denied/i.test(d.kind) ? 'warn' : 'info'}>{d.kind}</Chip>
            <small>{ago(d.at)}{d.pr ? ` · PR #${d.pr}` : ''} · {d.source}</small>
        </div>
        <div className="gov-decision-text">{inlineCode(d.text)}</div>
        <small className="gov-dim">
            {d.who ? `by ${d.who}` : 'who decided: not recorded'}
            {d.reason ? <> · why: {d.reason}</> : ' · no reason given'}
        </small>
    </div>
);
