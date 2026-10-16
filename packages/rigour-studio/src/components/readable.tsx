/**
 * The page kit's reading pieces, for long lists and long text: a clamped paragraph with Show more, client-side paging,
 * a search box with filter chips, a memory's `key: value` subject, a remembered choice and a loading skeleton.
 * ui.tsx re-exports them; styles live in ui.css.
 */
import React from 'react';
import { inlineCode } from './storyData';

const STORE_PREFIX = 'rigour-studio:';

/** A choice remembered in this browser (a tab, a filter, a page size); the initial value where storage is blocked. */
export function usePersisted<T extends string | number>(key: string | undefined, initial: T): [T, (value: T) => void] {
    const [value, setValue] = React.useState<T>(() => readStored(key, initial));
    const set = React.useCallback((next: T) => {
        setValue(next);
        if (!key) return;
        try { window.localStorage.setItem(STORE_PREFIX + key, String(next)); } catch { /* storage blocked: kept for this visit */ }
    }, [key]);
    return [value, set];
}

function readStored<T extends string | number>(key: string | undefined, initial: T): T {
    if (!key || typeof window === 'undefined') return initial;
    try {
        const raw = window.localStorage.getItem(STORE_PREFIX + key);
        if (raw === null) return initial;
        return (typeof initial === 'number' ? Number(raw) || initial : raw) as T;
    } catch {
        return initial;
    }
}

/** Roughly how many characters a line of body text holds at the list's measure; the server-side guess before measuring. */
const CHARS_PER_LINE = 90;
/** Layout effects run in the browser only; on the server (and in render tests) the character guess stands. */
const useBrowserLayoutEffect = typeof window === 'undefined' ? React.useEffect : React.useLayoutEffect;

/** Text clamped to `lines` lines, with a Show more / Show less button only when the text runs past them. */
export const Clamp: React.FC<{ text: string; lines?: number; className?: string }> = ({ text, lines = 2, className }) => {
    const id = React.useId();
    const ref = React.useRef<HTMLDivElement>(null);
    const [open, setOpen] = React.useState(false);
    const [overflows, setOverflows] = React.useState(text.length > lines * CHARS_PER_LINE);
    useBrowserLayoutEffect(() => {
        const el = ref.current;
        if (!el || open) return undefined;
        const measure = () => setOverflows(el.scrollHeight - el.clientHeight > 1);
        measure();
        if (typeof ResizeObserver === 'undefined') return undefined;
        const observer = new ResizeObserver(measure);
        observer.observe(el);
        return () => observer.disconnect();
    }, [text, lines, open]);
    return (
        <div className={`ui-clamp ${className ?? ''}`}>
            <div ref={ref} id={id} className={open ? 'ui-clamp-text' : 'ui-clamp-text clamped'} style={open ? undefined : { WebkitLineClamp: lines }}>{inlineCode(text)}</div>
            {(overflows || open) && (
                <button type="button" className="ui-clamp-toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
                    {open ? 'Show less' : 'Show more'}
                </button>
            )}
        </div>
    );
};

/** A subject's `key: value`, where the key is one identifier (a memory key such as `api_base`); null for any other text, such as "Note: …". */
function splitKeyed(text: string): { key: string; value: string } | null {
    const match = /^([A-Za-z0-9_.\-/@]{1,80}?):\s+([\s\S]+)$/.exec(text.trim());
    if (!match || /^[A-Z][a-z]*$/.test(match[1])) return null;
    return { key: match[1], value: match[2] };
}

/**
 * A memory or lesson subject: a `key: value` shows its key as a compact monospace title (the whole key on hover) and
 * its value clamped below; any other text is clamped as it is. `memoryKey` and `value` override the parse.
 */
export const MemoryText: React.FC<{ text: string; memoryKey?: string; value?: string; lines?: number; inline?: boolean }> = ({ text, memoryKey, value, lines = 2, inline }) => {
    const keyed = memoryKey !== undefined ? { key: memoryKey, value: value ?? text } : splitKeyed(text);
    if (!keyed) return <div className="ui-memtext"><Clamp text={text} lines={lines} /></div>;
    return (
        <div className={inline ? 'ui-memtext inline' : 'ui-memtext'}>
            <div className="ui-memkey" title={keyed.key}>{keyed.key}</div>
            <Clamp text={keyed.value} lines={lines} />
        </div>
    );
};

const PAGE_SIZES = [25, 50, 100] as const;

interface PageState { page: number; key: string }

/** The page shown: page 1 whenever the filter or search (`resetKey`) changed since the page was chosen, else the chosen page within range. */
function resolvePage(state: PageState, resetKey: string, total: number, size: number): number {
    const pages = Math.max(1, Math.ceil(total / size));
    return state.key === resetKey ? Math.min(Math.max(1, state.page), pages) : 1;
}

interface Paged<T> {
    items: T[];
    page: number;
    pages: number;
    size: number;
    total: number;
    start: number;
    setPage: (page: number) => void;
    setSize: (size: number) => void;
}

/** Client-side paging over `items`: `resetKey` names the filter and search, so a change goes back to page 1; the page size is remembered under `storageKey`. */
export function usePaged<T>(items: T[], { resetKey = '', storageKey }: { resetKey?: string; storageKey: string }): Paged<T> {
    const [state, setState] = React.useState<PageState>({ page: 1, key: resetKey });
    const [size, storeSize] = usePersisted<number>(`${storageKey}:size`, PAGE_SIZES[0]);
    // A new filter or search starts at page 1, and stays there when the person goes back to the earlier one.
    if (state.key !== resetKey) setState({ page: 1, key: resetKey });
    const page = resolvePage(state, resetKey, items.length, size);
    const start = (page - 1) * size;
    return {
        items: items.slice(start, start + size),
        page,
        pages: Math.max(1, Math.ceil(items.length / size)),
        size,
        total: items.length,
        start,
        setPage: (next: number) => setState({ page: next, key: resetKey }),
        setSize: (next: number) => { storeSize(next); setState({ page: 1, key: resetKey }); },
    };
}

const n = (value: number) => value.toLocaleString('en-US');

/** "1–25 of 9,358" with Previous and Next (First and Last past three pages) and a page size; nothing for one short page. ← and → page too. */
export function Pager<T>({ paged, label = 'items' }: { paged: Paged<T>; label?: string }) {
    const { page, pages, size, total, start, setPage, setSize } = paged;
    if (total <= PAGE_SIZES[0]) return null;
    const go = (next: number) => setPage(Math.min(pages, Math.max(1, next)));
    const onKeyDown = (e: React.KeyboardEvent) => {
        if (e.target instanceof HTMLSelectElement) return;
        if (e.key === 'ArrowRight') { e.preventDefault(); go(page + 1); }
        if (e.key === 'ArrowLeft') { e.preventDefault(); go(page - 1); }
    };
    return (
        <nav className="ui-pager" aria-label={`Pages of ${label}`} onKeyDown={onKeyDown}>
            <span className="ui-pager-count" aria-live="polite">{n(start + 1)}–{n(Math.min(total, start + size))} of {n(total)}</span>
            <div className="ui-pager-buttons">
                {pages > 3 && <button type="button" onClick={() => go(1)} disabled={page === 1} aria-label="First page">First</button>}
                <button type="button" onClick={() => go(page - 1)} disabled={page === 1} aria-label="Previous page">Previous</button>
                <span className="ui-pager-page">Page {n(page)} of {n(pages)}</span>
                <button type="button" onClick={() => go(page + 1)} disabled={page === pages} aria-label="Next page">Next</button>
                {pages > 3 && <button type="button" onClick={() => go(pages)} disabled={page === pages} aria-label="Last page">Last</button>}
            </div>
            <label className="ui-pager-size">
                <span>Per page</span>
                <select value={size} onChange={e => setSize(Number(e.target.value))}>{PAGE_SIZES.map(s => <option key={s} value={s}>{s}</option>)}</select>
            </label>
        </nav>
    );
}

export interface FilterChip { id: string; label: string; count?: number }

/** A search box, filter chips (one pressed at a time) and how many items match. */
export const FilterBar: React.FC<{
    query: string;
    onQuery: (query: string) => void;
    placeholder: string;
    chips?: FilterChip[];
    active?: string;
    onChip?: (id: string) => void;
    matching: number;
    noun?: [string, string];
    note?: React.ReactNode;
}> = ({ query, onQuery, placeholder, chips, active, onChip, matching, noun = ['item', 'items'], note }) => (
    <div className="ui-filterbar">
        <div className="ui-filterbar-row">
            <input className="ui-search" type="search" placeholder={placeholder} aria-label={placeholder} value={query} onChange={e => onQuery(e.target.value)} />
            <span className="ui-filterbar-count" aria-live="polite">{n(matching)} {matching === 1 ? noun[0] : noun[1]}{note ? <> · {note}</> : null}</span>
        </div>
        {chips && chips.length > 0 && (
            <div className="ui-filterchips" role="group" aria-label="Filter">
                {chips.map(c => (
                    <button key={c.id} type="button" aria-pressed={c.id === active} className={c.id === active ? 'on' : ''} onClick={() => onChip?.(c.id)}>
                        {c.label}{c.count !== undefined && <span className="ui-filterchip-count">{n(c.count)}</span>}
                    </button>
                ))}
            </div>
        )}
    </div>
);

/** Whether `text` contains every word of the search, ignoring case. */
export function matchesQuery(text: string, query: string): boolean {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return true;
    const hay = text.toLowerCase();
    return words.every(w => hay.includes(w));
}

/** Grey bars in place of a page's content while it loads, announced once to screen readers. */
export const Skeleton: React.FC<{ rows?: number; label?: string }> = ({ rows = 4, label = 'Loading' }) => (
    <div className="ui-skeleton" role="status" aria-label={label}>
        <div className="ui-skel-kpis">{[0, 1, 2, 3].map(i => <div key={i} className="ui-skel-block" />)}</div>
        {Array.from({ length: rows }, (_, i) => <div key={i} className="ui-skel-line" style={{ width: `${92 - (i % 3) * 14}%` }} />)}
    </div>
);
