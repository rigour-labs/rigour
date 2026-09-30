/**
 * Is the review loop working? Computed from the local event log
 * (`.rigour/events.jsonl`, written by the MCP server and the stop hook), so
 * nothing leaves the machine.
 *
 * - a finding is resolved when a later review no longer reports it (same rule, same file);
 * - a blocked stop is followed through when the same session later stops cleanly;
 * - a self-review is a rigour_review call made before an attempt to stop.
 */
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

export interface AgentEvent {
    type: string;
    timestamp?: string;
    tool?: string;
    status?: string;
    content?: Array<{ type: string; text?: string }>;
    session?: string;
    blocked?: boolean;
    /** Findings that blocked a stop. */
    blocking?: number;
}

export interface ReviewEffectiveness {
    toolCalls: Record<string, number>;
    reviews: number;
    failedReviews: number;
    findingsReported: number;
    findingsResolved: number;
    stopChecks: number;
    stopBlocks: number;
    blockedStopsFollowedThrough: number;
    stopsWithSelfReview: number;
}

const EVENTS = path.join('.rigour', 'events.jsonl');

export function readAgentEvents(cwd: string): AgentEvent[] {
    let text = '';
    try {
        text = fs.readFileSync(path.join(cwd, EVENTS), 'utf8');
    } catch {
        return [];
    }
    return text.split('\n').filter(Boolean).flatMap(line => {
        try {
            return [JSON.parse(line) as AgentEvent];
        } catch {
            return [];
        }
    });
}

/** Append an event in the same format the MCP server writes; never throws. */
export function appendAgentEvent(cwd: string, event: AgentEvent): void {
    try {
        fs.mkdirSync(path.join(cwd, '.rigour'), { recursive: true });
        fs.appendFileSync(path.join(cwd, EVENTS), JSON.stringify({ id: randomUUID(), timestamp: new Date().toISOString(), ...event }) + '\n');
    } catch {
        // The event log is best-effort; it must never break a hook or a tool call.
    }
}

/** `rule:file` keys, so a finding that moved lines is still the same finding. */
export function findingKeys(findings: Array<{ id?: string; file?: string }>): string[] {
    return findings.map(f => `${f.id ?? '?'}:${f.file ?? '?'}`);
}

export function computeEffectiveness(events: AgentEvent[]): ReviewEffectiveness {
    const stats: ReviewEffectiveness = {
        toolCalls: {}, reviews: 0, failedReviews: 0, findingsReported: 0, findingsResolved: 0,
        stopChecks: 0, stopBlocks: 0, blockedStopsFollowedThrough: 0, stopsWithSelfReview: 0,
    };
    const open = new Set<string>();
    const blockedSessions = new Set<string>();
    let reviewedSinceStop = false;
    for (const event of events) {
        if (event.type === 'tool_call' && event.tool) {
            stats.toolCalls[event.tool] = (stats.toolCalls[event.tool] ?? 0) + 1;
            if (event.tool === 'rigour_review') reviewedSinceStop = true;
        } else if (event.type === 'tool_response' && event.tool === 'rigour_review') {
            countReview(stats, open, reviewKeys(event));
        } else if (event.type === 'stop_review') {
            countStop(stats, blockedSessions, event, reviewedSinceStop);
            reviewedSinceStop = false;
        }
    }
    return stats;
}

function countReview(stats: ReviewEffectiveness, open: Set<string>, keys: string[] | null): void {
    if (keys === null) return;
    stats.reviews++;
    if (keys.length) stats.failedReviews++;
    const now = new Set(keys);
    for (const key of [...open]) {
        if (!now.has(key)) {
            open.delete(key);
            stats.findingsResolved++;
        }
    }
    for (const key of now) {
        if (!open.has(key)) {
            open.add(key);
            stats.findingsReported++;
        }
    }
}

function countStop(stats: ReviewEffectiveness, blockedSessions: Set<string>, event: AgentEvent, selfReviewed: boolean): void {
    const session = event.session ?? 'default';
    stats.stopChecks++;
    if (selfReviewed) stats.stopsWithSelfReview++;
    if (event.blocked) {
        stats.stopBlocks++;
        blockedSessions.add(session);
    } else if (blockedSessions.delete(session)) {
        stats.blockedStopsFollowedThrough++;
    }
}

/** Finding keys from a rigour_review response, or null when it is not a review result. */
function reviewKeys(event: AgentEvent): string[] | null {
    const text = event.content?.find(c => c.type === 'text')?.text;
    if (!text) return null;
    try {
        const body = JSON.parse(text);
        return Array.isArray(body.failures) ? findingKeys(body.failures) : null;
    } catch {
        return null;
    }
}
