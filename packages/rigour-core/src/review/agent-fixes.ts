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
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { Failure } from '../types/index.js';
import { checkId, recordOutcome } from './check-outcomes.js';

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
}

export interface ResolvedFix {
    id: string;
    file: string;
    rule: string;
    title?: string;
    details?: string;
    before: string;
    after: string;
    resolvedAt: string;
}

export interface FixCapture {
    opened: number;
    resolved: number;
    /** The fixes this review resolved, for turning into lessons (storage/fix-lessons.ts). */
    fixes: ResolvedFix[];
}

/** Record a review's findings: open new ones, resolve open ones the review no longer reports. */
export function recordReviewOutcome(cwd: string, findings: Failure[], reviewedFiles: string[]): FixCapture {
    const open = readOpen(cwd);
    const current = new Map(findings.flatMap(f => (f.files?.[0] ? [[`${f.id}:${f.files[0]}`, f] as const] : [])));
    const fixes = resolveGone(cwd, open, current, new Set(reviewedFiles));
    const opened = openNew(cwd, open, current);
    writeOpen(cwd, open);
    return { opened, resolved: fixes.length, fixes };
}

/** Open findings this review no longer reports: resolved when their file was reviewed and changed. */
function resolveGone(cwd: string, open: Record<string, OpenFinding>, current: Map<string, Failure>, reviewed: Set<string>): ResolvedFix[] {
    const resolved: ResolvedFix[] = [];
    for (const [key, entry] of Object.entries(open)) {
        if (current.has(key)) continue;
        if (!reviewed.has(entry.file)) {
            if (Date.now() - Date.parse(entry.openedAt) > OPEN_TTL_MS) delete open[key];
            continue;
        }
        const after = readSmall(cwd, entry.file);
        if (after !== null && after !== entry.before) {
            resolved.push(writeResolved(cwd, entry, after));
            recordOutcome(cwd, checkId({ rule: entry.rule, title: entry.title }), 'fixed');
        }
        delete open[key];
    }
    return resolved;
}

function openNew(cwd: string, open: Record<string, OpenFinding>, current: Map<string, Failure>): number {
    let opened = 0;
    for (const [key, finding] of current) {
        if (open[key]) continue;
        const file = finding.files![0];
        const before = readSmall(cwd, file);
        if (before === null) continue;
        open[key] = { file, rule: finding.id, title: finding.title, details: finding.details, before, openedAt: new Date().toISOString() };
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
    const fix: ResolvedFix = { id, file: entry.file, rule: entry.rule, title: entry.title, details: entry.details, before: entry.before, after, resolvedAt: new Date().toISOString() };
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
