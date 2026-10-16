/**
 * Studio's "Patterns": what Rigour knows about this codebase and what it handed agents. The function index
 * (.rigour/patterns.json, written by `rigour index` and kept fresh as agents edit), the kinds of problem Rigour's
 * checks keep finding (the local store's reinforced patterns), and the existing code agents were pointed to instead
 * of writing it again (reuse_suggested events). Read-only: nothing here writes.
 */
import fs from 'fs';
import path from 'path';
import { getRepositoryId, getStrongPatterns, openDatabase, type AgentEvent, type PatternRecord } from '@rigour-labs/core';
import { checkoutRoots, eventsAcross } from './studio-checkouts.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_DAYS = 28;
/** The index table is searched in the browser; past this many entries the rest are counted, not sent. */
const ENTRY_CAP = 5000;
const TOP_FILES = 8;
const EXAMPLES = 20;

interface IndexEntry { name: string; type: string; file: string; line: number; exported: boolean }

export interface StudioIndex {
    indexed: boolean;
    /** When the index was last rebuilt or updated; null when there is no index. */
    lastIndexed: string | null;
    total: number;
    files: number;
    byType: Array<{ type: string; count: number }>;
    topFiles: Array<{ file: string; count: number }>;
    entries: IndexEntry[];
    /** Entries past ENTRY_CAP, counted and not sent. */
    more: number;
    /** Whether matching by meaning is on (.rigour/index-status.json); null before any index run recorded it. */
    meaning: 'on' | 'off' | 'warming' | 'degraded' | null;
}

export interface RecurringPattern { pattern: string; description: string | null; timesSeen: number; strength: number; firstSeen: string; lastSeen: string; source: string }

export interface ReuseSuggestion { at: string; planned: string; existing: string; action: string }

export interface StudioPatterns {
    index: StudioIndex;
    /** recorded false: the local store could not be read on this machine, so nothing is known (not none). */
    recurring: { recorded: boolean; patterns: RecurringPattern[] };
    reuse: { days: number; recent: number; total: number; examples: ReuseSuggestion[] };
}

interface RawIndex { lastUpdated?: string; patterns?: Array<Partial<IndexEntry>>; files?: Array<{ path?: string; patternCount?: number }> }

function readJson<T>(file: string): T | null {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
    } catch {
        return null;
    }
}

const MEANING: Record<string, StudioIndex['meaning']> = { ready: 'on', disabled: 'off', warming: 'warming', degraded: 'degraded' };

function countBy<T>(items: T[], key: (item: T) => string): Map<string, number> {
    const counts = new Map<string, number>();
    for (const item of items) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1);
    return counts;
}

/** The function index of the first checkout that has one (this one first): what it holds, by kind and by file. */
function buildIndex(raw: RawIndex | null, status: { semantic?: string } | null): StudioIndex {
    const meaning = status?.semantic ? MEANING[status.semantic] ?? null : null;
    if (!raw) return { indexed: false, lastIndexed: null, total: 0, files: 0, byType: [], topFiles: [], entries: [], more: 0, meaning };
    const entries: IndexEntry[] = (raw.patterns ?? []).filter(p => p.name && p.file).map(p => ({
        name: String(p.name), type: String(p.type ?? 'other'), file: String(p.file), line: Number(p.line ?? 0), exported: !!p.exported,
    }));
    const byFile = countBy(entries, e => e.file);
    const ranked = (counts: Map<string, number>) => [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    return {
        indexed: true,
        lastIndexed: raw.lastUpdated ?? null,
        total: entries.length,
        files: raw.files?.length ?? byFile.size,
        byType: ranked(countBy(entries, e => e.type)).map(([type, count]) => ({ type, count })),
        topFiles: ranked(byFile).slice(0, TOP_FILES).map(([file, count]) => ({ file, count })),
        entries: entries.slice(0, ENTRY_CAP),
        more: Math.max(0, entries.length - ENTRY_CAP),
        meaning,
    };
}

function readIndex(roots: string[]): StudioIndex {
    const root = roots.find(r => fs.existsSync(path.join(r, '.rigour', 'patterns.json'))) ?? roots[0];
    const status = root ? readJson<{ semantic?: string }>(path.join(root, '.rigour', 'index-status.json')) : null;
    return buildIndex(root ? readJson<RawIndex>(path.join(root, '.rigour', 'patterns.json')) : null, status);
}

function toRecurring(rows: PatternRecord[]): RecurringPattern[] {
    return rows.map(r => ({
        pattern: r.pattern,
        description: r.description,
        timesSeen: r.times_seen,
        strength: r.strength,
        firstSeen: new Date(r.first_seen).toISOString(),
        lastSeen: new Date(r.last_seen).toISOString(),
        source: r.source,
    })).sort((a, b) => b.timesSeen - a.timesSeen || b.lastSeen.localeCompare(a.lastSeen));
}

/** Every reinforced pattern for this repository, strongest first; unrecorded when the local store cannot be opened. */
async function readRecurring(cwd: string): Promise<StudioPatterns['recurring']> {
    let db;
    try {
        db = await openDatabase();
    } catch {
        return { recorded: false, patterns: [] };
    }
    if (!db) return { recorded: false, patterns: [] };
    try {
        return { recorded: true, patterns: toRecurring(await getStrongPatterns(db, await getRepositoryId(cwd), 0)) };
    } catch {
        return { recorded: false, patterns: [] };
    } finally {
        await db.close();
    }
}

function buildReuse(events: AgentEvent[], now: Date): StudioPatterns['reuse'] {
    const since = now.getTime() - WINDOW_DAYS * DAY_MS;
    const all = events.filter(e => e.type === 'reuse_suggested');
    const recent = all.filter(e => Date.parse(e.timestamp ?? '') > since);
    return {
        days: WINDOW_DAYS,
        recent: recent.length,
        total: all.length,
        examples: [...all].reverse().slice(0, EXAMPLES).map(e => ({ at: e.timestamp ?? '', planned: e.planned ?? '', existing: e.existing ?? '', action: e.action ?? '' })),
    };
}

export async function loadPatterns(cwd: string, _url?: URL, now = new Date()): Promise<StudioPatterns> {
    const roots = checkoutRoots(cwd);
    return { index: readIndex(roots), recurring: await readRecurring(cwd), reuse: buildReuse(eventsAcross(roots), now) };
}
