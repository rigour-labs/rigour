/**
 * Score History Service
 *
 * Append-only JSONL tracking of quality scores over time.
 * Used for compliance dashboards, trend analysis, and audit reports.
 *
 * Uses JSONL (not JSON) to avoid read-modify-write race conditions
 * when multiple agents run checks concurrently.
 *
 * @since v2.17.0
 */

import * as fs from 'fs';
import * as path from 'path';

export interface ScoreEntry {
    timestamp: string;
    status: 'PASS' | 'FAIL' | 'SKIP' | 'ERROR';
    score: number;
    ai_health_score?: number;
    structural_score?: number;
    failureCount: number;
    severity_breakdown: Record<string, number>;
    provenance_breakdown: Record<string, number>;
}

export interface ScoreTrend {
    direction: 'improving' | 'stable' | 'degrading';
    delta: number;
    recentAvg: number;
    previousAvg: number;
    recentScores: number[];
}

const MAX_ENTRIES = 100;
const HISTORY_FILE = 'score-history.jsonl';

function getHistoryPath(cwd: string): string {
    return path.join(cwd, '.rigour', HISTORY_FILE);
}

/**
 * Record a score entry after a rigour check run.
 * Appends a single JSONL line. Auto-trims to MAX_ENTRIES.
 */
export function recordScore(cwd: string, report: {
    status: string;
    stats: {
        score?: number;
        ai_health_score?: number;
        structural_score?: number;
        severity_breakdown?: Record<string, number>;
        provenance_breakdown?: Record<string, number>;
    };
    failures: { length: number } | any[];
}): void {
    try {
        const rigourDir = path.join(cwd, '.rigour');
        if (!fs.existsSync(rigourDir)) {
            fs.mkdirSync(rigourDir, { recursive: true });
        }

        const entry: ScoreEntry = {
            timestamp: new Date().toISOString(),
            status: report.status as ScoreEntry['status'],
            score: report.stats.score ?? 100,
            ai_health_score: report.stats.ai_health_score,
            structural_score: report.stats.structural_score,
            failureCount: Array.isArray(report.failures) ? report.failures.length : 0,
            severity_breakdown: report.stats.severity_breakdown ?? {},
            provenance_breakdown: report.stats.provenance_breakdown ?? {},
        };

        const historyPath = getHistoryPath(cwd);
        fs.appendFileSync(historyPath, JSON.stringify(entry) + '\n');

        // Auto-trim if over MAX_ENTRIES
        trimHistory(historyPath);
    } catch {
        // Silent fail — score tracking should never break the check command
    }
}

/**
 * Read the last N score entries.
 */
export function getScoreHistory(cwd: string, limit: number = 20): ScoreEntry[] {
    try {
        const historyPath = getHistoryPath(cwd);
        if (!fs.existsSync(historyPath)) return [];

        const lines = fs.readFileSync(historyPath, 'utf-8')
            .trim()
            .split('\n')
            .filter(line => line.length > 0);

        const entries = lines.map(line => JSON.parse(line) as ScoreEntry);
        return entries.slice(-limit);
    } catch {
        return [];
    }
}

/**
 * Calculate score trend from history.
 * Compares average of last 5 runs vs previous 5 runs.
 */
export function getScoreTrend(cwd: string): ScoreTrend | null {
    const history = getScoreHistory(cwd, 20);
    if (history.length < 3) return null;

    const scores = history.map(e => e.score);
    const recentScores = scores.slice(-5);
    const previousScores = scores.slice(-10, -5);

    const recentAvg = recentScores.reduce((a, b) => a + b, 0) / recentScores.length;

    if (previousScores.length === 0) {
        return {
            direction: 'stable',
            delta: 0,
            recentAvg: Math.round(recentAvg),
            previousAvg: Math.round(recentAvg),
            recentScores,
        };
    }

    const previousAvg = previousScores.reduce((a, b) => a + b, 0) / previousScores.length;
    const delta = recentAvg - previousAvg;

    let direction: ScoreTrend['direction'];
    if (delta > 3) direction = 'improving';
    else if (delta < -3) direction = 'degrading';
    else direction = 'stable';

    return {
        direction,
        delta: Math.round(delta * 10) / 10,
        recentAvg: Math.round(recentAvg),
        previousAvg: Math.round(previousAvg),
        recentScores,
    };
}

/**
 * Trim JSONL file to last MAX_ENTRIES lines.
 */
function trimHistory(historyPath: string): void {
    try {
        const lines = fs.readFileSync(historyPath, 'utf-8')
            .trim()
            .split('\n')
            .filter(line => line.length > 0);

        if (lines.length > MAX_ENTRIES) {
            const trimmed = lines.slice(-MAX_ENTRIES);
            fs.writeFileSync(historyPath, trimmed.join('\n') + '\n');
        }
    } catch {
        // Silent fail
    }
}
