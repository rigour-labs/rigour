/** The Patterns page's parts: the function index, the problems Rigour's checks keep finding, and code agents were pointed to. Patterns.tsx loads the data. */
import React from 'react';
import { ago, plural } from './storyData';
import { Card, Chip, Empty, Meter, Row, Table, type KpiItem } from './ui';
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
const shortDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

export function patternKpis(data: PatternsData): KpiItem[] {
    const { index, recurring, reuse } = data;
    const callable = index.byType.filter(t => CALLABLE.has(t.type)).reduce((n, t) => n + t.count, 0);
    return [
        { label: 'Functions indexed', value: index.indexed ? callable : '—', note: index.indexed ? `Of ${plural(index.total, 'entry', 'entries')} in ${plural(index.files, 'file')}, types and constants included.` : 'No index yet: rigour index builds one.' },
        { label: 'Last indexed', value: index.lastIndexed ? ago(index.lastIndexed) : '—', note: index.lastIndexed ? 'Kept fresh as agents edit files.' : 'Never indexed in this checkout.' },
        { label: 'Recurring problems', value: recurring.recorded ? recurring.patterns.length : '—', note: recurring.recorded ? 'Kinds of problem Rigour\'s checks keep finding.' : 'Not recorded: the local database could not be read.' },
        { label: `Reuse suggestions, ${reuse.days} days`, value: reuse.recent, note: `${reuse.total} in all: existing code an agent was pointed to.` },
    ];
}

const SHOWN = 100;

/** Every function, type and constant Rigour indexed, searchable by name, kind or file. */
export const IndexTable: React.FC<{ index: PatternsData['index']; initialQuery?: string }> = ({ index, initialQuery = '' }) => {
    const [query, setQuery] = React.useState(initialQuery);
    if (!index.indexed) {
        return <Card title="The function index"><Empty>Nothing indexed in this checkout yet. <code>rigour index</code> builds it; after that Rigour keeps it fresh as agents edit, and points an agent to a function that exists before it writes a near-copy.</Empty></Card>;
    }
    const q = query.trim().toLowerCase();
    const matches = q ? index.entries.filter(e => `${e.name} ${e.type} ${e.file}`.toLowerCase().includes(q)) : index.entries;
    return (
        <Card title="The function index" meta={`${plural(index.total, 'entry', 'entries')}`} flush>
            <div className="ui-card-body">
                <input className="pat-search" type="search" placeholder="Search by name, kind or file" aria-label="Search the function index" value={query} onChange={e => setQuery(e.target.value)} />
            </div>
            {matches.length === 0
                ? <div className="ui-card-body"><Empty>Nothing in the index matches “{query}”.</Empty></div>
                : <Table rows={matches.slice(0, SHOWN)} rowKey={e => `${e.file}:${e.line}:${e.name}`} columns={[
                    { label: 'Name', cell: e => <span className="ui-mono">{e.name}</span> },
                    { label: 'Kind', cell: e => <Chip>{e.type}</Chip> },
                    { label: 'File', wrap: true, cell: e => <span className="ui-mono pat-file">{e.file}:{e.line}</span> },
                    { label: 'Exported', cell: e => (e.exported ? 'yes' : 'no') },
                ]} />}
            <div className="ui-card-body pat-note">
                {matches.length > SHOWN ? `Showing ${SHOWN} of ${matches.length}; search to narrow. ` : ''}
                {index.more ? `${index.more} more entries are not listed here. ` : ''}
                How often each is used is not recorded by the index.
            </div>
        </Card>
    );
};

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
                <div key={f.file} className="pat-bar"><span className="ui-mono pat-file">{f.file}</span><span>{f.count}</span><Meter share={f.count / top} /></div>
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
