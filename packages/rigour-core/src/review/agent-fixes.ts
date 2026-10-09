/**
 * Fixes agents make to Rigour findings, captured so they can become rules.
 *
 * Capture is cheap and happens in the review loop (MCP review, stop hook):
 * a finding's file content is kept when the finding appears, and when a later
 * review of that file no longer reports it, the before and after are stored as
 * a resolved fix. Learning is expensive and happens later, outside the loop
 * (`rigour learn --agent-fixes`), with the same validation as any learned rule.
 *
 * A finding only counts as resolved when its file was part of the review that
 * no longer reports it: a file committed out of the working tree was not fixed.
 *
 * Nor is a finding an older version of Rigour's checks reported: when the checks change (an upgrade), a finding they
 * no longer report closes as "checker changed", never as a fix, with no story and no outcome. Otherwise a false
 * finding the old checks made would be credited to the agent the first time it edited the file.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { Failure } from '../types/index.js';
import { checkId, recordOutcome } from './check-outcomes.js';
import { appendStory, compactDiff, type CatchStage } from './stories.js';
import { dismissedKeys, findingKey } from './quiet.js';

const DIR = path.join('.rigour', 'agent-fixes');
const MAX_FILE_BYTES = 200_000;
const OPEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface OpenFinding {
    file: string;
    rule: string;
    /** What the finding said; absent in entries captured before it was kept. */
    title?: string;
    details?: string;
    before: string;
    openedAt: string;
    /** The stage that first reported it; absent in entries captured before stages were kept. */
    stage?: CatchStage;
    /** Its dismissal key (quiet.ts): a finding someone dismissed was not fixed. */
    key?: string;
    /** The version of the checks that reported it (CHECKER_VERSION); absent in entries captured before it was kept. */
    checker?: string;
}

/** The version of Rigour's checks: the core package's own. A finding another version opened is never credited as a fix. */
const CHECKER_VERSION = coreVersion();

function coreVersion(): string {
    try {
        return JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version ?? 'unknown';
    } catch {
        return 'unknown';
    }
}

/** Whether another version of the checks opened it. */
const stale = (entry: OpenFinding) => entry.checker !== CHECKER_VERSION;

export interface ResolvedFix {
    id: string;
    file: string;
    rule: string;
    title?: string;
    details?: string;
    before: string;
    after: string;
    resolvedAt: string;
    stage?: CatchStage;
    /** When the finding was first reported, for time to fix. */
    openedAt?: string;
}

export interface FixCapture {
    opened: number;
    resolved: number;
    /** The fixes this review resolved, for turning into lessons (storage/fix-lessons.ts). */
    fixes: ResolvedFix[];
    /** Findings another version of the checks opened that this one no longer reports: closed, never credited as fixes. */
    checkerChanged: number;
}

/**
 * Record a review's findings: open new ones, resolve open ones the review no longer reports.
 * Each resolved fix is also kept as a story, credited to the stage that first reported it.
 */
export function recordReviewOutcome(cwd: string, findings: Failure[], reviewedFiles: string[], stage: CatchStage = 'review'): FixCapture {
    const open = readOpen(cwd);
    const current = new Map(findings.flatMap(f => (f.files?.[0] ? [[`${f.id}:${f.files[0]}`, f] as const] : [])));
    const { resolved: fixes, checkerChanged } = resolveGone(cwd, open, current, new Set(reviewedFiles), stage);
    const opened = openNew(cwd, open, current, stage);
    writeOpen(cwd, open);
    return { opened, resolved: fixes.length, fixes, checkerChanged };
}

/** Open findings this review no longer reports: resolved when their file was reviewed and changed. */
function resolveGone(cwd: string, open: Record<string, OpenFinding>, current: Map<string, Failure>, reviewed: Set<string>, stage: CatchStage): { resolved: ResolvedFix[]; checkerChanged: number } {
    const resolved: ResolvedFix[] = [];
    let checkerChanged = 0;
    const dismissed = dismissedKeys(cwd);
    for (const [key, entry] of Object.entries(open)) {
        if (current.has(key)) {
            entry.checker = CHECKER_VERSION; // still reported by these checks: theirs now
            continue;
        }
        if (entry.key && dismissed.has(entry.key)) {
            delete open[key]; // gone because a person dismissed it, not because anyone fixed it
            continue;
        }
        if (!reviewed.has(entry.file)) {
            if (Date.now() - Date.parse(entry.openedAt) > OPEN_TTL_MS) delete open[key];
            continue;
        }
        if (stale(entry)) {
            delete open[key]; // the checks changed, not the code: no fix, no story, no outcome
            checkerChanged++;
            continue;
        }
        const fix = creditFix(cwd, entry, stage);
        if (fix) resolved.push(fix);
        delete open[key];
    }
    return { resolved, checkerChanged };
}

/**
 * A finding these checks reported and no longer do, in a file that changed since: the agent's fix, kept with its before
 * and after, a story credited to the stage that first reported it, and a `fixed` outcome. A file unchanged since is no
 * fix (the finding vanished without an edit): undefined.
 */
function creditFix(cwd: string, entry: OpenFinding, stage: CatchStage): ResolvedFix | undefined {
    const after = readSmall(cwd, entry.file);
    if (after === null || after === entry.before) return undefined;
    const fix = writeResolved(cwd, entry, after);
    recordOutcome(cwd, checkId({ rule: entry.rule, title: entry.title }), 'fixed');
    appendStory(cwd, { at: fix.resolvedAt, openedAt: fix.openedAt, stage: fix.stage ?? stage, file: fix.file, rule: fix.rule, title: fix.title ?? fix.rule, details: fix.details, diff: compactDiff(fix.before, fix.after) });
    return fix;
}

/**
 * Re-checks, in place, the findings another version of the checks opened at `stage` (with `all`, every one open at
 * it), with `check` (this version's, for that stage): what it still reports stays open, now as its own. What it no
 * longer reports closes: one another version opened as checker-changed, never a fix; one this version opened the way
 * any review resolves it (a fix when its file changed since, creditFix). Runs nothing when no such finding is open.
 */
export async function recheckOpenFindings(cwd: string, stage: CatchStage, check: (files: string[]) => Promise<Failure[]>, all = false): Promise<{ closed: number; kept: number; fixed: number }> {
    const open = readOpen(cwd);
    const old = Object.entries(open).filter(([, entry]) => (all || stale(entry)) && entry.stage === stage);
    if (old.length === 0) return { closed: 0, kept: 0, fixed: 0 };
    const files = [...new Set(old.map(([, entry]) => entry.file))].filter(file => fs.existsSync(path.join(cwd, file)));
    const reported = new Set((await check(files)).flatMap(f => (f.files?.[0] ? [`${f.id}:${f.files[0]}`] : [])));
    let closed = 0;
    let fixed = 0;
    for (const [key, entry] of old) {
        if (reported.has(key)) {
            entry.checker = CHECKER_VERSION;
            continue;
        }
        if (!stale(entry) && creditFix(cwd, entry, stage)) fixed++;
        else closed++;
        delete open[key];
    }
    writeOpen(cwd, open);
    return { closed, kept: old.length - closed - fixed, fixed };
}

function openNew(cwd: string, open: Record<string, OpenFinding>, current: Map<string, Failure>, stage: CatchStage): number {
    let opened = 0;
    for (const [key, finding] of current) {
        if (open[key]) continue;
        const file = finding.files![0];
        const before = readSmall(cwd, file);
        if (before === null) continue;
        open[key] = { file, rule: finding.id, title: finding.title, details: finding.details, before, openedAt: new Date().toISOString(), stage, key: findingKey(finding), checker: CHECKER_VERSION };
        opened++;
    }
    return opened;
}

export function listResolvedFixes(cwd: string): ResolvedFix[] {
    const dir = path.join(cwd, DIR, 'resolved');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter(n => n.endsWith('.json')).sort().flatMap(name => {
        try {
            return [JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as ResolvedFix];
        } catch {
            return [];
        }
    });
}

export function removeResolvedFix(cwd: string, id: string): void {
    fs.rmSync(path.join(cwd, DIR, 'resolved', `${id}.json`), { force: true });
}

export function openFindingCount(cwd: string): number {
    return Object.keys(readOpen(cwd)).length;
}

/** Findings reported and not fixed yet, newest first: what still needs someone. */
export function listOpenFindings(cwd: string): Array<Omit<OpenFinding, 'before'>> {
    const dismissed = dismissedKeys(cwd);
    return Object.values(readOpen(cwd))
        .filter(entry => !(entry.key && dismissed.has(entry.key)))
        .map(({ before: _before, ...rest }) => rest)
        .sort((a, b) => b.openedAt.localeCompare(a.openedAt));
}

function readOpen(cwd: string): Record<string, OpenFinding> {
    try {
        return JSON.parse(fs.readFileSync(path.join(cwd, DIR, 'open.json'), 'utf8'));
    } catch {
        return {};
    }
}

function writeOpen(cwd: string, open: Record<string, OpenFinding>): void {
    try {
        fs.mkdirSync(path.join(cwd, DIR), { recursive: true });
        fs.writeFileSync(path.join(cwd, DIR, 'open.json'), JSON.stringify(open));
    } catch {
        // Capture is best-effort; it must never break a review.
    }
}

function writeResolved(cwd: string, entry: OpenFinding, after: string): ResolvedFix {
    const id = crypto.createHash('sha256').update(`${entry.rule}\0${entry.file}\0${entry.before}\0${after}`).digest('hex').slice(0, 16);
    const fix: ResolvedFix = { id, file: entry.file, rule: entry.rule, title: entry.title, details: entry.details, before: entry.before, after, resolvedAt: new Date().toISOString(), ...(entry.stage ? { stage: entry.stage } : {}), openedAt: entry.openedAt };
    try {
        fs.mkdirSync(path.join(cwd, DIR, 'resolved'), { recursive: true });
        fs.writeFileSync(path.join(cwd, DIR, 'resolved', `${id}.json`), JSON.stringify(fix));
    } catch {
        // Best-effort, as above.
    }
    return fix;
}

function readSmall(cwd: string, file: string): string | null {
    try {
        const full = path.join(cwd, file);
        if (fs.statSync(full).size > MAX_FILE_BYTES) return null;
        return fs.readFileSync(full, 'utf8');
    } catch {
        return null;
    }
}
