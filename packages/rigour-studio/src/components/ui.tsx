import React from 'react';
import { formatCount } from './format';
import './ui.css';

export { Clamp, FilterBar, MemoryText, Pager, Skeleton, matchesQuery, setStorageRepository, usePaged, usePersisted, type FilterChip } from './readable';
export { formatCount } from './format';

/** A number shown as a count, with separators; anything else as it is. */
const shown = (value: React.ReactNode) => (typeof value === 'number' ? formatCount(value) : value);

export type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'plain';

/** A page's title, what it answers, and an optional action on the right. */
export const PageHeader: React.FC<{ title: string; lead?: React.ReactNode; aside?: React.ReactNode }> = ({ title, lead, aside }) => (
    <div className="ui-head">
        <div><h1>{title}</h1>{lead && <p>{lead}</p>}</div>
        {aside}
    </div>
);

export interface KpiItem { label: string; value: React.ReactNode; note?: React.ReactNode }

/** The few numbers a page leads with. A number Rigour has not recorded is shown as a dash with why, never as 0. */
export const Kpis: React.FC<{ items: KpiItem[] }> = ({ items }) => (
    <div className="ui-kpis">
        {items.map(item => (
            <div className="ui-kpi" key={item.label}>
                <span className="ui-label">{item.label}</span>
                <span className="ui-kpi-value">{shown(item.value)}</span>
                {item.note && <span className="ui-kpi-note">{item.note}</span>}
            </div>
        ))}
    </div>
);

export const Card: React.FC<{ title?: string; meta?: React.ReactNode; flush?: boolean; children: React.ReactNode }> = ({ title, meta, flush, children }) => (
    <section className="ui-card">
        {title && <div className="ui-card-head"><h2>{title}</h2>{meta && <span>{meta}</span>}</div>}
        {flush ? children : <div className="ui-card-body">{children}</div>}
    </section>
);

export const Chip: React.FC<{ tone?: Tone; children: React.ReactNode }> = ({ tone = 'plain', children }) => (
    <span className={`ui-chip ${tone === 'plain' ? '' : tone}`}>{children}</span>
);

/**
 * One set of words and colours for where an item stands, used by every page: the same meaning reads the same way on
 * Memory, Governance, This week and Progress.
 */
const STATE_CHIPS = {
    waiting: { word: 'waiting for a person', tone: 'warn' },
    team: { word: 'shared with the team', tone: 'ok' },
    machine: { word: 'kept on this machine', tone: 'ok' },
    repo: { word: 'kept in this repository', tone: 'ok' },
    dropped: { word: 'dropped', tone: 'plain' },
    notRule: { word: 'not a rule', tone: 'plain' },
    replaced: { word: 'replaced', tone: 'plain' },
    open: { word: 'open', tone: 'warn' },
} as const satisfies Record<string, { word: string; tone: Tone }>;

export type ItemState = keyof typeof STATE_CHIPS;

export const StateChip: React.FC<{ state: ItemState }> = ({ state }) => <Chip tone={STATE_CHIPS[state].tone}>{STATE_CHIPS[state].word}</Chip>;

/** The colour of a decision or outcome named in words: taking back, dropping and denying read as a warning. */
export function toneOfDecision(kind: string): Tone {
    return /rejected|withdrawn|not a bug|dismissed|denied|dropped|taken back|replaced/i.test(kind) ? 'warn' : 'info';
}

/** A section that could not load: what went wrong, and what to do about it. */
export const LoadError: React.FC<{ what: string; error: string }> = ({ what, error }) => (
    <div className="ui-error" role="alert">
        <strong>Couldn't load {what}.</strong>
        <span>{error}. Check that <code>rigour studio</code> is still running in your terminal, then reload this page.</span>
    </div>
);

/** Shared folders beside the home folders; a path under one names nobody, so it is shown as it is. */
const SHARED_HOMES = '(?:Shared|Public|Default|All Users|Default User)';
/** Where a path can start: the start of the text, a space, a quote, `=`, `(`, or a `:` or `;` between list entries. */
const PATH_START = `(^|[\\s"'=(:;])`;
// Not after a drive letter's colon (C:/Users/... is the Windows form, below).
const UNIX_HOME = new RegExp(`(^|[\\s"'=(;]|(?<!(?:^|[\\s"'=(;])[A-Za-z]):)/(?:Users|home)/(?!${SHARED_HOMES}(?:[/\\s"';:]|$))[^/\\s"';:]+(?=[/\\s"';:]|$)`, 'g');
// A Windows user name may hold spaces ("Bob Smith"): it runs to the next slash or quote; a name with no slash after it stops at a space.
const WINDOWS_HOME = new RegExp(`${PATH_START}[A-Za-z]:[\\\\/]Users[\\\\/](?!${SHARED_HOMES}(?:[\\\\/"']|$))(?:[^\\\\/"';:\\s][^\\\\/"';:]*?(?=[\\\\/"'])|[^\\\\/"';:\\s]+(?=[\\s;]|$))`, 'g');

/**
 * A command with the person's home folder shown as `~`: `/Users/<name>`, `/home/<name>` and `C:\Users\<name>` (either
 * slash), wherever a path starts, quoted or in a PATH-style list. Shared and Public folders are not anyone's home.
 */
function homeAsTilde(text: string): string {
    return text.replace(WINDOWS_HOME, '$1~').replace(UNIX_HOME, '$1~');
}

/** Copies text, through the clipboard API where the page may use it and a hidden text area where it may not. */
async function copyText(text: string): Promise<boolean> {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        const area = document.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        const done = document.execCommand('copy');
        area.remove();
        return done;
    }
}

/** How long "Copied" stays on the button before it reads Copy again. */
const COPY_SAID_MS = 2000;

/** A command to run, on one line with the whole of it on hover, and Copy. Copy gives the command exactly as recorded. */
export const FixCommand: React.FC<{ command: string }> = ({ command }) => {
    const [said, setSaid] = React.useState<'Copy' | 'Copied' | 'Copy failed'>('Copy');
    React.useEffect(() => {
        if (said === 'Copy') return undefined;
        const reset = window.setTimeout(() => setSaid('Copy'), COPY_SAID_MS);
        return () => window.clearTimeout(reset);
    }, [said]);
    const shown = homeAsTilde(command);
    const copy = async () => setSaid((await copyText(command).catch(() => false)) ? 'Copied' : 'Copy failed');
    return (
        <span className="ui-fix">
            <code className="ui-fix-code" title={shown}>{shown}</code>
            <button type="button" className="ui-fix-copy" onClick={copy} aria-label={`Copy the command: ${shown}`} aria-live="polite">{said}</button>
        </span>
    );
};

/** What an empty section means, and how to fill it: never a bare "no data". */
export const Empty: React.FC<{ children: React.ReactNode }> = ({ children }) => <div className="ui-empty">{children}</div>;

export const Row: React.FC<{ label: React.ReactNode; value: React.ReactNode }> = ({ label, value }) => (
    <div className="ui-row"><span>{label}</span><span>{shown(value)}</span></div>
);

export const Meter: React.FC<{ share: number }> = ({ share }) => (
    <div className="ui-meter"><div style={{ width: `${Math.max(0, Math.min(1, share)) * 100}%` }} /></div>
);

/**
 * `width` fixes a column's width (the table then lays out to fit its card); `num` right-aligns a number column;
 * `secondary` hides the column on a narrow screen, where the row's own page still shows it.
 */
export interface Column<T> { label: string; cell: (row: T) => React.ReactNode; wrap?: boolean; width?: string; num?: boolean; secondary?: boolean }

const cellClass = (c: { num?: boolean; secondary?: boolean }) => [c.num ? 'num' : '', c.secondary ? 'ui-secondary' : ''].filter(Boolean).join(' ') || undefined;

/**
 * A table; with `onRow`, a click anywhere on a row opens it, and the first cell is a button so the keyboard can too.
 * Cells of an openable row's first column hold phrasing content only (spans, not divs): they sit inside that button.
 */
export function Table<T>({ rows, columns, rowKey, onRow }: { rows: T[]; columns: Column<T>[]; rowKey: (row: T, index: number) => string; onRow?: (row: T) => void }) {
    const fixed = columns.some(c => c.width);
    return (
        <div className="ui-table-wrap">
            <table className={fixed ? 'ui-table fixed' : 'ui-table'}>
                {fixed && <colgroup>{columns.map(c => <col key={c.label} style={c.width ? { width: c.width } : undefined} />)}</colgroup>}
                <thead><tr>{columns.map(c => <th key={c.label} className={cellClass(c)}>{c.label}</th>)}</tr></thead>
                <tbody>
                    {rows.map((row, index) => (
                        <tr key={rowKey(row, index)} className={onRow ? 'ui-clickable' : undefined} onClick={onRow ? () => onRow(row) : undefined}>
                            {columns.map((c, i) => (
                                <td key={c.label} className={cellClass(c)} style={c.wrap ? undefined : { whiteSpace: 'nowrap' }}>
                                    {onRow && i === 0 ? <RowButton onOpen={() => onRow(row)}>{shown(c.cell(row))}</RowButton> : shown(c.cell(row))}
                                </td>
                            ))}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

const RowButton: React.FC<{ onOpen: () => void; children: React.ReactNode }> = ({ onOpen, children }) => (
    <button type="button" className="ui-row-open" onClick={e => { e.stopPropagation(); onOpen(); }}>{children}</button>
);

export interface TimelineStep { key: string; title: string; when?: string; tone?: 'done' | 'ok' | 'bad' | 'todo'; children?: React.ReactNode }

export const Timeline: React.FC<{ steps: TimelineStep[] }> = ({ steps }) => (
    <div className="ui-timeline">
        {steps.map((step, i) => (
            <div className="ui-step" key={step.key}>
                <div className="ui-dot-col"><div className={`ui-dot ${step.tone && step.tone !== 'todo' ? step.tone : ''}`}>{i + 1}</div><div className="ui-line" /></div>
                <div className="ui-step-body">
                    <div className="ui-step-title"><strong>{step.title}</strong>{step.when && <span>{step.when}</span>}</div>
                    {step.children}
                </div>
            </div>
        ))}
    </div>
);

interface WeekBar { label: string; values: number[] }

/** Weeks side by side, one bar per series; colours follow `series`. */
export const WeekChart: React.FC<{ weeks: WeekBar[]; series: Array<{ label: string; color: string }> }> = ({ weeks, series }) => {
    const max = Math.max(1, ...weeks.flatMap(w => w.values));
    return (
        <div>
            <div className="ui-weeks" role="img" aria-label={weeks.map(w => `${w.label}: ${w.values.map((v, i) => `${v} ${series[i]?.label ?? ''}`).join(', ')}`).join('; ')}>
                {weeks.map(week => (
                    <div className="ui-week" key={week.label}>
                        <div className="ui-week-bars">
                            {week.values.map((v, i) => <span key={i} title={`${v} ${series[i]?.label ?? ''}`} style={{ height: `${(v / max) * 100}%`, background: series[i]?.color }} />)}
                        </div>
                        <small>{week.label}</small>
                    </div>
                ))}
            </div>
            <div className="ui-legend" style={{ marginTop: 10 }}>{series.map(s => <span key={s.label}><i style={{ background: s.color }} />{s.label}</span>)}</div>
        </div>
    );
};

/**
 * Tabs with their panel: `id` names both, so each tab says which panel it controls. Arrow keys, Home and End move
 * between tabs and open the one they land on; only the open tab is in the Tab order.
 */
export const Tabs: React.FC<{ id: string; tabs: Array<{ id: string; label: string }>; active: string; onChange: (id: string) => void }> = ({ id, tabs, active, onChange }) => {
    const onKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
        const next = nextTab(e.key, index, tabs.length);
        if (next === null) return;
        e.preventDefault();
        onChange(tabs[next].id);
        e.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
    };
    return (
        <div className="ui-tabs" role="tablist">
            {tabs.map((t, i) => (
                <button
                    key={t.id} type="button" role="tab" id={`${id}-tab-${t.id}`} aria-controls={`${id}-panel`} aria-selected={t.id === active}
                    tabIndex={t.id === active ? 0 : -1} className={t.id === active ? 'on' : ''} onClick={() => onChange(t.id)} onKeyDown={e => onKeyDown(e, i)}
                >{t.label}</button>
            ))}
        </div>
    );
};

function nextTab(key: string, index: number, count: number): number | null {
    if (key === 'ArrowRight') return (index + 1) % count;
    if (key === 'ArrowLeft') return (index - 1 + count) % count;
    if (key === 'Home') return 0;
    if (key === 'End') return count - 1;
    return null;
}

/** The panel the open tab of `Tabs` with the same `id` shows. */
export const TabPanel: React.FC<{ id: string; active: string; children: React.ReactNode }> = ({ id, active, children }) => (
    <div className="ui-tabpanel" role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-tab-${active}`}>{children}</div>
);
