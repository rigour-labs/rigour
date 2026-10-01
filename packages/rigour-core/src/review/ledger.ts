/**
 * Review ledger: which changed functions were reviewed before the PR, by whom,
 * with what verdict.
 *
 * Entries are keyed by the function's content hash, so any edit after the
 * review makes the entry stale: a ledger can say "this exact code was looked
 * at", never "this function is fine forever". The local log is append-only
 * (.rigour/review-ledger.jsonl); `exportReviewed` writes the shareable form
 * (.rigour/reviewed.json: hashes and verdicts only, no code, no notes) that a
 * team may commit so the PR bot skips what was already reviewed.
 */
import fs from 'fs';
import path from 'path';

const LOG = path.join('.rigour', 'review-ledger.jsonl');
export const REVIEWED_FILE = path.join('.rigour', 'reviewed.json');
const MAX_LOG_BYTES = 2 * 1024 * 1024;

export type ReviewVerdict = 'fixed' | 'no_issue';

export interface LedgerEntry {
    file: string;
    function: string;
    hash: string;
    /** 'agent', 'human', or 'byok:<model>'. */
    reviewer: string;
    verdict: ReviewVerdict;
    note: string;
    at: string;
}

export interface ReviewedKey {
    file: string;
    function: string;
    hash: string;
}

export function recordReview(cwd: string, entry: Omit<LedgerEntry, 'at'>, at = new Date().toISOString()): LedgerEntry {
    const full: LedgerEntry = { ...entry, at };
    const file = path.join(cwd, LOG);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(full) + '\n');
    if (fs.statSync(file).size > MAX_LOG_BYTES) {
        const lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
        fs.writeFileSync(file, lines.slice(Math.floor(lines.length / 2)).join('\n') + '\n');
    }
    return full;
}

export function readLedger(cwd: string): LedgerEntry[] {
    try {
        return fs.readFileSync(path.join(cwd, LOG), 'utf8').split('\n').filter(Boolean)
            .flatMap(line => { try { return [JSON.parse(line) as LedgerEntry]; } catch { return []; } });
    } catch {
        return [];
    }
}

/** True when this exact function text has a review on record (local log or a committed reviewed.json). */
export function isReviewed(reviewed: ReviewedKey[], key: ReviewedKey): boolean {
    return reviewed.some(r => r.file === key.file && r.function === key.function && r.hash === key.hash);
}

export function reviewedKeys(cwd: string): ReviewedKey[] {
    return [...readLedger(cwd), ...readReviewedFile(cwd)];
}

/** The shareable form: latest verdict per function hash, sorted, no code and no notes. */
export function exportReviewed(cwd: string): { path: string; entries: number } {
    const latest = new Map<string, LedgerEntry>();
    for (const entry of readLedger(cwd)) latest.set(`${entry.file}\u0000${entry.function}\u0000${entry.hash}`, entry);
    const entries = [...latest.values()]
        .map(e => ({ file: e.file, function: e.function, hash: e.hash, reviewer: e.reviewer, verdict: e.verdict }))
        .sort((a, b) => a.file.localeCompare(b.file) || a.function.localeCompare(b.function) || a.hash.localeCompare(b.hash));
    const out = path.join(cwd, REVIEWED_FILE);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify({ version: 1, entries }, null, 2) + '\n');
    return { path: REVIEWED_FILE, entries: entries.length };
}

function readReviewedFile(cwd: string): ReviewedKey[] {
    try {
        const parsed = JSON.parse(fs.readFileSync(path.join(cwd, REVIEWED_FILE), 'utf8'));
        return Array.isArray(parsed?.entries)
            ? parsed.entries.filter((e: any) => typeof e?.file === 'string' && typeof e?.function === 'string' && typeof e?.hash === 'string')
            : [];
    } catch {
        return [];
    }
}
