/** The Patterns page's parts: the function index, the problems Rigour's checks keep finding, and code agents were pointed to. Patterns.tsx loads the data. */
import React from 'react';
import { ago, plural } from './storyData';
import { Card, Chip, Empty, FilterBar, Meter, Pager, Row, Table, matchesQuery, usePaged, usePersisted, type Column, type KpiItem } from './ui';
import './patterns.css';

interface IndexEntry { name: string; type: string; file: string; line: number; exported: boolean }
export interface PatternsData {
    index: {
        indexed: boolean; lastIndexed: string | null; total: number; files: number;
        byType: Array<{ type: string; count: number }>; topFiles: Array<{ file: string; count: number }>;
        entries: IndexEntry[]; more: number; meaning: 'on' | 'off' | 'warming' | 'degraded' | null;
    };
    recurring: { recorded: boolean; patterns: Array<{ pattern: string; description: string | null; timesSeen: number; strength: number; firstSeen: string; lastSeen: string; source: string }> };
    reuse: { days: number; recent: number; total: number; examples: Array<{ at: string; planned: string; existing: string; action: string }> };
}

/** Kinds an agent calls, as opposed to types, constants and the rest. */
const CALLABLE = new Set(['function', 'method', 'hook', 'component', 'handler', 'middleware', 'resolver', 'rpc', 'command', 'task']);
const num = (n: number) => n.toLocaleString('en-US');
const shortDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

export function patternKpis(data: PatternsData): KpiItem[] {
    const { index, recurring, reuse } = data;
    const callable = index.byType.filter(t => CALLABLE.has(t.type)).reduce((n, t) => n + t.count, 0);
    return [
        { label: 'Functions indexed', value: index.indexed ? num(callable) : '—', note: index.indexed ? `Of ${num(index.total)} entries in ${num(index.files)} files, types and constants included.` : 'No index yet: rigour index builds one.' },
        { label: 'Last indexed', value: index.lastIndexed ? ago(index.lastIndexed) : '—', note: index.lastIndexed ? 'Kept fresh as agents edit files.' : 'Never indexed in this checkout.' },
        { label: 'Recurring problems', value: recurring.recorded ? recurring.patterns.length : '—', note: recurring.recorded ? 'Kinds of problem Rigour\'s checks keep finding.' : 'Not recorded: the local database could not be read.' },
        { label: `Reuse suggestions, ${reuse.days} days`, value: reuse.recent, note: `${reuse.total} in all: existing code an agent was pointed to.` },
    ];
}

/** Kinds offered as filter chips, most entries first; the rest are reached by search. */
const KIND_CHIPS = 6;

const INDEX_COLUMNS: Column<IndexEntry>[] = [
    { label: 'Name', width: '34%', cell: e => <span className="ui-mono ui-ellipsis" title={e.name}>{e.name}</span> },
    { label: 'Kind', width: '120px', cell: e => <Chip>{e.type}</Chip> },
    { label: 'File', cell: e => <span className="ui-mono ui-ellipsis pat-dim pat-path" title={`${e.file}:${e.line}`}>{`\u200e${e.file}:${e.line}\u200e`}</span> },
    { label: 'Exported', width: '104px', cell: e => (e.exported ? <Chip tone="info">exported</Chip> : <span className="pat-dim" aria-label="not exported">—</span>) },
];

/** Entries of one kind (or all) whose name, kind or file match the search. */
function filterEntries(entries: IndexEntry[], kind: string, query: string): IndexEntry[] {
    return entries.filter(e => (kind === 'all' || e.type === kind) && matchesQuery(`${e.name} ${e.type} ${e.file}`, query));
}

/** Every function, type and constant Rigour indexed, searchable by name, kind or file, 25 to a page. */
export const IndexTable: React.FC<{ index: PatternsData['index']; initialQuery?: string }> = ({ index, initialQuery = '' }) => {
    const [query, setQuery] = React.useState(initialQuery);
    const [stored, setKind] = usePersisted<string>('patterns:kind', 'all');
    const kinds = React.useMemo(() => kindCounts(index.entries), [index.entries]);
    const kind = stored === 'all' || kinds.some(([k]) => k === stored) ? stored : 'all';
    const matches = React.useMemo(() => filterEntries(index.entries, kind, query), [index.entries, kind, query]);
    const paged = usePaged(matches, { resetKey: `${kind}\u0000${query}`, storageKey: 'patterns:index' });
    if (!index.indexed) {
        return <Card title="The function index"><Empty>Nothing indexed in this checkout yet. <code>rigour index</code> builds it; after that Rigour keeps it fresh as agents edit, and points an agent to a function that exists before it writes a near-copy.</Empty></Card>;
    }
    const chips = [{ id: 'all', label: 'All', count: index.entries.length }, ...kinds.slice(0, KIND_CHIPS).map(([k, n]) => ({ id: k, label: k, count: n }))];
    const capped = index.more ? <span title="Search covers these; the rest are counted, not sent to the browser">first {index.entries.length.toLocaleString('en-US')} of {index.total.toLocaleString('en-US')} indexed, search to narrow</span> : undefined;
    return (
        <Card title="The function index" meta={`${num(index.files)} files`} flush>
            <div className="ui-card-body">
                <FilterBar query={query} onQuery={setQuery} placeholder="Search by name, kind or file" chips={chips} active={kind} onChip={setKind} matching={matches.length} noun={['entry', 'entries']} note={capped} />
            </div>
            {matches.length === 0
                ? <div className="ui-card-body"><Empty>Nothing in the index matches “{query}”{kind === 'all' ? '' : ` among ${kind} entries`}.</Empty></div>
                : <Table rows={paged.items} rowKey={(e, i) => `${e.file}:${e.line}:${e.type}:${e.name}:${i}`} columns={INDEX_COLUMNS} />}
            <Pager paged={paged} label="index entries" />
            <div className="ui-card-body pat-note">How often each is used is not recorded by the index.</div>
        </Card>
    );
};

function kindCounts(entries: IndexEntry[]): Array<[string, number]> {
    const counts = new Map<string, number>();
    for (const e of entries) counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

const MEANING_WORDS: Record<string, string> = { on: 'on', off: 'off (rigour index --no-semantic)', warming: 'starting', degraded: 'unavailable, matching by name' };

/** What the index holds, by kind and by file, and whether agents' questions are matched by meaning. */
export const IndexShape: React.FC<{ index: PatternsData['index'] }> = ({ index }) => {
    if (!index.indexed) return null;
    const top = Math.max(1, ...index.topFiles.map(f => f.count));
    return (
        <Card title="What the index holds">
            {index.byType.slice(0, 8).map(t => <Row key={t.type} label={t.type} value={t.count} />)}
            {index.meaning && <Row label="Matching by meaning" value={MEANING_WORDS[index.meaning]} />}
            <div className="pat-subhead">Files with the most entries</div>
            {index.topFiles.map(f => (
                <div key={f.file} className="pat-bar"><span className="ui-mono pat-file" title={f.file}>{f.file}</span><span>{f.count}</span><Meter share={f.count / top} /></div>
            ))}
        </Card>
    );
};

const RECURRING_SHOWN = 10;

/** Kinds of problem Rigour's own checks keep finding here, from the local database; a kind not seen for 30 days fades. */
export const RecurringTable: React.FC<{ recurring: PatternsData['recurring'] }> = ({ recurring }) => {
    const [all, setAll] = React.useState(false);
    if (!recurring.recorded) return <Card title="Problems that keep coming back"><Empty>Not recorded: the local database (<code>~/.rigour/rigour.db</code>) could not be read on this machine.</Empty></Card>;
    if (recurring.patterns.length === 0) {
        return <Card title="Problems that keep coming back"><Empty>None yet. Each recorded check run (<code>rigour check</code> or <code>rigour scan</code>) counts once per kind of problem it finds; kinds that keep showing up are listed here.</Empty></Card>;
    }
    const hidden = recurring.patterns.length - RECURRING_SHOWN;
    return (
        <Card title="Problems that keep coming back" meta="each check run counts once per kind" flush>
            <Table rows={all ? recurring.patterns : recurring.patterns.slice(0, RECURRING_SHOWN)} rowKey={p => p.pattern} columns={[
                { label: 'Kind of problem', wrap: true, cell: p => <div className="pat-problem"><span className="ui-mono">{p.pattern}</span>{p.description && <span className="pat-note">{p.description}</span>}</div> },
                { label: 'Check runs', cell: p => p.timesSeen },
                { label: 'First seen', cell: p => shortDate(p.firstSeen) },
                { label: 'Last seen', cell: p => shortDate(p.lastSeen) },
                { label: 'Strength', cell: p => <div className="pat-strength" title="Grows each time it is seen, fades after 30 days unseen"><Meter share={p.strength} /></div> },
            ]} />
            {hidden > 0 && <div className="ui-card-body"><button type="button" className="ui-link" onClick={() => setAll(!all)}>{all ? 'Show the top 10' : `Show all ${recurring.patterns.length}`}</button></div>}
        </Card>
    );
};

/** What an agent was about to write, and the existing code Rigour pointed it to instead. */
export const ReuseList: React.FC<{ reuse: PatternsData['reuse'] }> = ({ reuse }) => (
    <Card title="Pointed to existing code" meta={`${reuse.recent} in ${reuse.days} days`}>
        {reuse.examples.length === 0
            ? <Empty>No agent has been pointed to existing code yet. When an agent asks before writing a new function (the <code>rigour_check_pattern</code> tool), Rigour points it to one that already exists.</Empty>
            : reuse.examples.map(r => (
                <div className="ui-item" key={`${r.at}-${r.planned}`}>
                    <div className="pat-reuse-head"><Chip tone={r.action === 'BLOCK' ? 'warn' : 'plain'}>{r.action === 'BLOCK' ? 'told to reuse' : 'similar exists'}</Chip><span className="pat-note">{ago(r.at)}</span></div>
                    <div>About to write <span className="ui-mono">{r.planned}</span>; pointed to <span className="ui-mono pat-file">{r.existing}</span></div>
                </div>
            ))}
    </Card>
);
