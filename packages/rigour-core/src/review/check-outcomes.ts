/**
 * How this repository treats each check: findings fixed versus dismissed.
 *
 * Every check gets a Beta(fixed + 1, dismissed + 1) posterior, so its mean is
 * the chance that a finding from it is worth acting on here, and it starts at
 * an honest 0.5 with no evidence. Advisory checks the team keeps dismissing are
 * muted once the evidence is clear; proven checks are never muted, because
 * quiet must not cost correctness.
 *
 * Local files under .rigour/: check-outcomes.json (the counts) and
 * reported-findings.json (which check each recent finding key came from, so a
 * dismissal by key can be attributed).
 */
import fs from 'fs';
import path from 'path';
import { readStateFile } from './trusted-state.js';

const OUTCOMES_FILE = path.join('.rigour', 'check-outcomes.json');
const REPORTED_FILE = path.join('.rigour', 'reported-findings.json');
const MAX_REPORTED = 2000;

/** Outcomes a check needs before it can be muted, and the posterior mean below which it is. */
export const MUTE_MIN_OUTCOMES = 5;
export const MUTE_BELOW = 0.25;

export interface CheckOutcome {
    fixed: number;
    dismissed: number;
}

export interface CheckPrecision extends CheckOutcome {
    check: string;
    /** Posterior mean of Beta(fixed + 1, dismissed + 1). */
    precision: number;
    muted: boolean;
}

/** A check is a gate and the rule within it: `ast` alone would mute complexity and parameter count together. */
export function checkId(finding: { id?: string; rule?: string; title?: string }): string {
    const gate = finding.id ?? finding.rule ?? 'unknown';
    return finding.title?.trim() ? `${gate}: ${finding.title.trim()}` : gate;
}

export function precisionOf(outcome: CheckOutcome): number {
    return (outcome.fixed + 1) / (outcome.fixed + outcome.dismissed + 2);
}

export function isMuted(outcome: CheckOutcome | undefined): boolean {
    if (!outcome) return false;
    return outcome.fixed + outcome.dismissed >= MUTE_MIN_OUTCOMES && precisionOf(outcome) < MUTE_BELOW;
}

/** Outcomes in the working tree, or at `ref` for an independent review (trusted-state.ts). */
export function readOutcomes(cwd: string, ref?: string): Record<string, CheckOutcome> {
    if (!ref) return readJson(path.join(cwd, OUTCOMES_FILE)) ?? {};
    try { return JSON.parse(readStateFile(cwd, OUTCOMES_FILE, ref) ?? '{}'); } catch { return {}; }
}

export function recordOutcome(cwd: string, check: string, kind: keyof CheckOutcome): void {
    const outcomes = readOutcomes(cwd);
    const current = outcomes[check] ?? { fixed: 0, dismissed: 0 };
    outcomes[check] = { ...current, [kind]: current[kind] + 1 };
    writeJson(path.join(cwd, OUTCOMES_FILE), outcomes);
}

/** Every check with an outcome, most dismissed first. */
export function checkPrecisions(cwd: string): CheckPrecision[] {
    return Object.entries(readOutcomes(cwd))
        .map(([check, outcome]) => ({ check, ...outcome, precision: precisionOf(outcome), muted: isMuted(outcome) }))
        .sort((a, b) => a.precision - b.precision);
}

/** Remember which check each reported finding key came from (most recent kept). */
export function rememberReported(cwd: string, entries: Array<{ key: string; check: string }>): void {
    if (entries.length === 0) return;
    const reported: Record<string, string> = readJson(path.join(cwd, REPORTED_FILE)) ?? {};
    for (const { key, check } of entries) {
        delete reported[key];
        reported[key] = check;
    }
    const kept = Object.entries(reported).slice(-MAX_REPORTED);
    writeJson(path.join(cwd, REPORTED_FILE), Object.fromEntries(kept));
}

export function reportedCheck(cwd: string, key: string): string | undefined {
    return (readJson(path.join(cwd, REPORTED_FILE)) as Record<string, string> | undefined)?.[key];
}

function readJson(file: string): any {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return undefined;
    }
}

function writeJson(file: string, value: unknown): void {
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
    } catch {
        // Learning is best-effort; a read-only checkout still reviews.
    }
}
