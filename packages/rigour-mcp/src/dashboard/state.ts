/**
 * Dashboard State — Server-side state accumulator
 *
 * Maintains the current governance state that gets injected into
 * the MCP App dashboard HTML on each resource fetch.
 * Single-threaded Node.js — no locking needed.
 */

export interface TimelineEntry {
    timestamp: string;
    tool: string;
    status: string;
    details: string;
}

export interface DashboardState {
    currentScore: number | null;
    status: "pass" | "fail" | "scanning" | null;
    timeline: TimelineEntry[];
    severityBreakdown: Record<string, number>;
    brainPatterns: number;
    brainTrend: string | null;
}

const MAX_TIMELINE = 50;

const state: DashboardState = {
    currentScore: null,
    status: null,
    timeline: [],
    severityBreakdown: {},
    brainPatterns: 0,
    brainTrend: null,
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
    if (severity) state.severityBreakdown = severity;
}

export function updateBrainStatus(patterns: number, trend?: string): void {
    state.brainPatterns = patterns;
    if (trend) state.brainTrend = trend;
}

export function setScanning(): void {
    state.status = "scanning";
}
