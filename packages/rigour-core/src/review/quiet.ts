/**
 * Quiet by default: a review speaks only when it can prove the defect.
 *
 * Proven findings come from rules that trace the defect itself: a value
 * followed from where it enters to where it does harm (semantic bugs and the
 * rules learned from fixes), an import that resolves to nothing, a secret in
 * the source, a model finding grounded in code it read (only when a model was
 * asked for), a function that behaves differently before and after.
 * Heuristics (size, complexity, patterns that guess at intent) are advisory:
 * returned for whoever asks, never deciding a verdict, never posted, never
 * blocking. A team that wants them back sets review.include_heuristics.
 *
 * A finding a person judged "not a bug" is dismissed by its key and never
 * reported again (.rigour/dismissed.json, meant to be committed). An
 * independent review reads it from the base (trusted-state.ts), so a change
 * cannot dismiss its own findings.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { Failure } from '../types/index.js';
import { checkId, isMuted, readOutcomes, recordOutcome, reportedCheck } from './check-outcomes.js';
import { readStateFile } from './trusted-state.js';

const PROVEN_GATES = new Set(['semantic-bugs', 'hallucinated-imports', 'security-patterns', 'deep-analysis', 'diff-tests', 'unused-export', 'orphan-file']);
export const DISMISSED_FILE = path.join('.rigour', 'dismissed.json');

export function isProven(failure: Failure): boolean {
    return PROVEN_GATES.has(failure.id);
}

/** The same finding across runs and pushes: gate, file and message, never the line (lines move). */
export function findingKey(failure: Failure): string {
    return crypto.createHash('sha256').update(`${failure.id}\u0000${failure.files?.[0] ?? ''}\u0000${failure.details}`).digest('hex').slice(0, 16);
}

export interface QuietSplit {
    speaking: Failure[];
    advisory: Failure[];
    /** Advisory findings from checks this repository keeps dismissing (check-outcomes.ts); counted, not listed. */
    muted: number;
    dismissed: number;
    /** Which gates the dismissed findings came from: where Rigour is wrong for this team. */
    dismissedByGate: Record<string, number>;
}

/** `trustedRef`: read dismissals and outcomes as of that commit, not as the change left them. */
export function quietSplit(cwd: string, findings: Failure[], includeHeuristics = false, trustedRef?: string): QuietSplit {
    const dismissed = dismissedKeys(cwd, trustedRef);
    const outcomes = readOutcomes(cwd, trustedRef);
    const split: QuietSplit = { speaking: [], advisory: [], muted: 0, dismissed: 0, dismissedByGate: {} };
    for (const finding of findings) {
        if (dismissed.has(findingKey(finding))) {
            split.dismissed++;
            split.dismissedByGate[finding.id] = (split.dismissedByGate[finding.id] ?? 0) + 1;
        }
        else if (includeHeuristics || isProven(finding)) split.speaking.push(finding);
        else if (isMuted(outcomes[checkId(finding)])) split.muted++;
        else split.advisory.push(finding);
    }
    return split;
}

export function dismissedKeys(cwd: string, ref?: string): Set<string> {
    try {
        const parsed = JSON.parse(readStateFile(cwd, DISMISSED_FILE, ref) ?? '');
        return new Set(Array.isArray(parsed?.entries) ? parsed.entries.map((e: any) => e?.key).filter((k: unknown) => typeof k === 'string') : []);
    } catch {
        return new Set();
    }
}

/** Record "not a bug" for a finding key; idempotent. */
export function dismissFinding(cwd: string, key: string, reason: string, at = new Date().toISOString()): boolean {
    if (!/^[0-9a-f]{16}$/.test(key)) return false;
    const file = path.join(cwd, DISMISSED_FILE);
    let entries: Array<{ key: string; reason: string; at: string; check?: string }> = [];
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (Array.isArray(parsed?.entries)) entries = parsed.entries;
    } catch {
        // First dismissal in this repository.
    }
    if (entries.some(e => e.key === key)) return true;
    // The check this key came from (remembered when review reported it) feeds its precision.
    const check = reportedCheck(cwd, key);
    entries.push({ key, reason: reason.trim(), at, ...(check ? { check } : {}) });
    if (check) recordOutcome(cwd, check, 'dismissed');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 1, entries }, null, 2) + '\n');
    return true;
}
