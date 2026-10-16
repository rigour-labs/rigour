import React, { useMemo, useState } from 'react';
import { Card, Chip, Empty, FilterBar, FixCommand, MemoryText, Pager, Table, matchesQuery, toneOfDecision, usePaged, usePersisted, type Column, type Tone } from './ui';
import { ago } from './storyData';
import './story.css';
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
    if (coverage.rows.length === 0 || coverage.covered === 0) return <CoverageSummary coverage={coverage} fixes={fixes} onSetup={onSetup} />;
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
                        {fixes.map(f => <div key={f.name}><span>{f.name}</span><FixCommand command={f.fix} /></div>)}
                    </div>
                )}
                <button type="button" className="ui-link" onClick={onSetup}>Open Setup to fix what is off</button>
            </div>
        </Card>
    );
};

/** Coverage with nothing switched on, as one row: what is missing, what to run on request, and Setup. */
const CoverageSummary: React.FC<{ coverage: Coverage; fixes: Array<{ name: string; fix: string }>; onSetup: () => void }> = ({ coverage, fixes, onSetup }) => {
    const [open, setOpen] = useState(false);
    const what = coverage.rows.length === 0 ? 'Hooks not set up for any agent' : `No moment switched on for ${coverage.rows.length === 1 ? 'the one agent' : `any of ${coverage.rows.length} agents`} found here`;
    return (
        <section className="ui-card gov-summary" aria-label="Is every agent covered?">
            <div className="gov-summary-row">
                <Chip tone="warn">not covered</Chip>
                <span className="gov-summary-text"><strong>{what}</strong> · agents write without Rigour's checks until <span className="ui-mono">rigour setup</span> runs.</span>
                {fixes.length > 0 && <button type="button" className="ui-link" aria-expanded={open} aria-controls="gov-coverage-fixes" onClick={() => setOpen(!open)}>{open ? 'Hide what to run' : `What to run (${fixes.length})`}</button>}
                <button type="button" className="st-btn small" onClick={onSetup}>Open Setup</button>
            </div>
            {open && <div id="gov-coverage-fixes" className="gov-fixes gov-summary-fixes">{fixes.map(f => <div key={f.name}><span>{f.name}</span><FixCommand command={f.fix} /></div>)}</div>}
        </section>
    );
};

/** Shown once above the log when most decisions name nobody, instead of "not recorded" on every row. */
const UNNAMED_NOTE = 'Who decided is recorded once the team database has the 7.0.11 rules; older decisions show no name.';

/** Decisions of one kind (or all) whose text, who, why or kind match the search. */
function filterDecisions(decisions: Decision[], kind: string, query: string): Decision[] {
    return decisions.filter(d => (kind === 'all' || d.kind === kind) && matchesQuery(`${d.kind} ${d.text} ${d.who ?? ''} ${d.reason ?? ''} ${d.source}`, query));
}

/** Every decision people made about Rigour here, newest first: filtered by kind, searchable, 25 to a page. */
export const DecisionsCard: React.FC<{ decisions: Decision[]; initialQuery?: string }> = ({ decisions, initialQuery = '' }) => {
    const [stored, setKind] = usePersisted<string>('governance:kind', 'all');
    const [query, setQuery] = useState(initialQuery);
    const counts = useMemo(() => {
        const map = new Map<string, number>();
        for (const d of decisions) map.set(d.kind, (map.get(d.kind) ?? 0) + 1);
        return [...map].sort((a, b) => b[1] - a[1]);
    }, [decisions]);
    const kind = stored === 'all' || counts.some(([k]) => k === stored) ? stored : 'all';
    const shown = useMemo(() => filterDecisions(decisions, kind, query), [decisions, kind, query]);
    const paged = usePaged(shown, { resetKey: `${kind}\u0000${query}`, storageKey: 'governance:decisions' });
    const unnamed = decisions.filter(d => !d.who).length;
    return (
        <Card title="Who decided what, and why" meta={decisions.length ? 'newest first' : undefined} flush>
            {decisions.length === 0
                ? <div className="ui-card-body"><Empty>No decisions recorded yet. They appear when someone marks a finding "not a bug", accepts or rejects a lesson (<span className="ui-mono">rigour learn-reviews --promote</span> or <span className="ui-mono">--reject</span>), approves a compiled check, or answers an agent's request in Studio.</Empty></div>
                : (
                    <>
                        <div className="ui-card-body">
                            <FilterBar
                                query={query} onQuery={setQuery} placeholder="Search decisions by text, who or why" matching={shown.length} noun={['decision', 'decisions']}
                                chips={[{ id: 'all', label: 'All', count: decisions.length }, ...counts.map(([k, n]) => ({ id: k, label: k, count: n }))]} active={kind} onChip={setKind}
                            />
                            {unnamed * 2 > decisions.length && <div className="gov-note">{UNNAMED_NOTE}</div>}
                        </div>
                        {shown.length === 0
                            ? <div className="ui-card-body"><Empty>No decision matches “{query}”.</Empty></div>
                            : <div className="ui-list">{paged.items.map((d, i) => <DecisionRow key={`${d.at}:${paged.start + i}`} decision={d} />)}</div>}
                        <Pager paged={paged} label="decisions" />
                    </>
                )}
        </Card>
    );
};

/** One decision: its kind, what it was about (a key as its title, the rest on one line), when, and who and why only where recorded. */
const DecisionRow: React.FC<{ decision: Decision }> = ({ decision: d }) => (
    <div className="ui-list-row gov-decision">
        <div className="gov-decision-kind"><Chip tone={toneOfDecision(d.kind)}>{d.kind}</Chip></div>
        <div className="gov-decision-body">
            <MemoryText text={d.text} lines={1} />
            <span className="ui-meta">
                {[ago(d.at), d.pr ? `PR #${d.pr}` : '', d.source, d.who ? `by ${d.who}` : '', d.reason ? `why: ${d.reason}` : ''].filter(Boolean).join(' · ')}
            </span>
        </div>
    </div>
);
