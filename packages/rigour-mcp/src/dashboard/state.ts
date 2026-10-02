/**
 * Dashboard State — Server-side state accumulator
 *
 * Maintains the current governance state that gets injected into
 * the MCP App dashboard HTML on each resource fetch.
 * Single-threaded Node.js — no locking needed.
 */

import type { KnowledgeSummary } from './knowledge.js';

export interface TimelineEntry {
    timestamp: string;
    tool: string;
    status: string;
    details: string;
}

export interface DashboardState {
    currentScore: number | null;
    status: "pass" | "fail" | "scanning" | null;
    /** Where the score came from: a check in this session, or the last report on disk. */
    scoreSource: "session" | "last-report" | null;
    timeline: TimelineEntry[];
    severityBreakdown: Record<string, number>;
    /** What Rigour knows about this repository (knowledge.ts); null until the first tool call. */
    knowledge: KnowledgeSummary | null;
}

const MAX_TIMELINE = 50;

const state: DashboardState = {
    currentScore: null,
    status: null,
    scoreSource: null,
    timeline: [],
    severityBreakdown: {},
    knowledge: null,
};

export function getState(): DashboardState {
    return state;
}

export function pushTimelineEntry(tool: string, status: string, details: string): void {
    state.timeline.push({
        timestamp: new Date().toISOString(),
        tool,
        status,
        details,
    });
    if (state.timeline.length > MAX_TIMELINE) {
        state.timeline = state.timeline.slice(-MAX_TIMELINE);
    }
}

export function updateScore(
    score: number,
    status: "pass" | "fail",
    severity?: Record<string, number>,
): void {
    state.currentScore = score;
    state.status = status;
    state.scoreSource = "session";
    if (severity) state.severityBreakdown = severity;
}

/**
 * Start from the last check run anywhere (CLI, hook, CI) while this session has not run one:
 * otherwise the dashboard shows "--" next to a fix packet that came from that very report.
 */
export function seedFromLastReport(report: { status?: string; stats?: { score?: number; severity_breakdown?: Record<string, number> } } | null): void {
    if (state.scoreSource === "session" || typeof report?.stats?.score !== "number") return;
    state.currentScore = report.stats.score;
    state.status = report.status === "PASS" ? "pass" : "fail";
    state.scoreSource = "last-report";
    if (report.stats.severity_breakdown) state.severityBreakdown = report.stats.severity_breakdown;
}

export function updateKnowledge(knowledge: KnowledgeSummary | null): void {
    if (knowledge) state.knowledge = knowledge;
}

export function setScanning(): void {
    state.status = "scanning";
}
