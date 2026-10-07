/**
 * Quality history: every gate run's failures by provenance, kept in .rigour/adaptive-history.json, and the
 * trends read from it (Z-score of recent runs against the earlier baseline), overall and per provenance.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../utils/logger.js';

export type QualityTrend = 'improving' | 'stable' | 'degrading';

// ─── Per-Provenance Tracking (v5) ───────────────────────────────────

export interface ProvenanceRunData {
    aiDriftFailures: number;
    structuralFailures: number;
    securityFailures: number;
    governanceFailures?: number;
    deepAnalysisFailures?: number;
}

export interface ProvenanceTrends {
    aiDrift: QualityTrend;
    structural: QualityTrend;
    security: QualityTrend;
    aiDriftZScore: number;
    structuralZScore: number;
    securityZScore: number;
}

// Historical failure data (persisted to .rigour/adaptive-history.json)
interface FailureHistory {
    runs: {
        timestamp: string;
        passedGates: number;
        failedGates: number;
        totalFailures: number;
        /** Per-provenance breakdown (v5+, absent in legacy data) */
        provenance?: ProvenanceRunData;
    }[];
    lastUpdated: string;
}

let cachedHistory: FailureHistory | null = null;

// ─── Statistical Utilities ──────────────────────────────────────────

/**
 * Compute mean and standard deviation of an array of numbers.
 * Returns { mean: 0, std: 0 } for empty arrays.
 */
function meanAndStd(values: number[]): { mean: number; std: number } {
    if (values.length === 0) return { mean: 0, std: 0 };
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
    return { mean, std: Math.sqrt(variance) };
}

/**
 * Calculate Z-score for a value against a population.
 * Z > 2.0 → statistically abnormal HIGH (degrading)
 * Z < -2.0 → statistically abnormal LOW (improving)
 * Returns 0 if std is 0 (all values identical).
 */
function zScore(value: number, mean: number, std: number): number {
    if (std === 0) return 0;
    return Math.round(((value - mean) / std) * 100) / 100;
}

/**
 * Determine trend from Z-score.
 * For failure counts: positive Z = more failures = degrading.
 */
function trendFromZScore(z: number): QualityTrend {
    if (z > 2.0) return 'degrading';
    if (z < -2.0) return 'improving';
    return 'stable';
}

// ─── History Persistence ────────────────────────────────────────────

/**
 * Load failure history from disk
 */
function loadHistory(cwd: string): FailureHistory {
    if (cachedHistory) return cachedHistory;

    const historyPath = path.join(cwd, '.rigour', 'adaptive-history.json');
    try {
        if (fs.existsSync(historyPath)) {
            cachedHistory = JSON.parse(fs.readFileSync(historyPath, 'utf-8'));
            return cachedHistory!;
        }
    } catch (e) {
        Logger.debug('Failed to load adaptive history, starting fresh');
    }

    cachedHistory = { runs: [], lastUpdated: new Date().toISOString() };
    return cachedHistory;
}

/**
 * Save failure history to disk
 */
function saveHistory(cwd: string, history: FailureHistory): void {
    const rigourDir = path.join(cwd, '.rigour');
    if (!fs.existsSync(rigourDir)) {
        fs.mkdirSync(rigourDir, { recursive: true });
    }
    const historyPath = path.join(rigourDir, 'adaptive-history.json');
    fs.writeFileSync(historyPath, JSON.stringify(history, null, 2));
    cachedHistory = history;
}

// ─── Public API ─────────────────────────────────────────────────────

/**
 * Record a gate run for historical tracking.
 * v5: accepts optional per-provenance breakdown.
 */
export function recordGateRun(
    cwd: string,
    passedGates: number,
    failedGates: number,
    totalFailures: number,
    provenance?: ProvenanceRunData
): void {
    const history = loadHistory(cwd);
    history.runs.push({
        timestamp: new Date().toISOString(),
        passedGates,
        failedGates,
        totalFailures,
        provenance,
    });

    // Keep last 100 runs
    if (history.runs.length > 100) {
        history.runs = history.runs.slice(-100);
    }

    history.lastUpdated = new Date().toISOString();
    saveHistory(cwd, history);
}

/**
 * Get quality trend using Z-score analysis (v5).
 *
 * How it works:
 * 1. Take the last N runs (baseline window, default 20)
 * 2. Compute mean and std of failure counts
 * 3. Take the most recent window (last 5 runs)
 * 4. Compute the average failure count in the recent window
 * 5. Z-score = (recent_avg - baseline_mean) / baseline_std
 *
 * Z > 2.0 → statistically abnormal spike → DEGRADING
 * Z < -2.0 → statistically abnormal drop → IMPROVING
 *
 * Why better than delta: A project with 100 failures/run and a spike to 108
 * is stable (Z ≈ 0.5). A project with 2 failures/run and a spike to 8
 * is degrading (Z ≈ 3.0). Z-score normalizes for project size.
 */
export function getQualityTrend(cwd: string): QualityTrend {
    const history = loadHistory(cwd);
    const RECENT_WINDOW = 5;
    const MIN_BASELINE = 5;

    // Need enough data for both a baseline and a separate recent window
    if (history.runs.length < RECENT_WINDOW + MIN_BASELINE) return 'stable';

    // Non-overlapping windows: baseline excludes recent to avoid Z-score compression.
    // When recent data is part of the baseline, Z-scores are mathematically bounded
    // at ~1.73 for a 5-of-20 overlap, which never exceeds the 2.0 threshold.
    const recent = history.runs.slice(-RECENT_WINDOW);
    const baseline = history.runs.slice(0, -RECENT_WINDOW);

    const baselineFailures = baseline.map(r => r.totalFailures);
    const { mean, std } = meanAndStd(baselineFailures);

    const recentAvg = recent.reduce((sum, r) => sum + r.totalFailures, 0) / recent.length;
    const z = zScore(recentAvg, mean, std);

    return trendFromZScore(z);
}

/**
 * Get per-provenance trend analysis (v5).
 *
 * Runs separate Z-score analysis for each provenance category.
 * This is the core differentiator: Rigour can tell you
 * "your AI is getting worse" separately from "your code quality is dropping."
 *
 * Falls back gracefully for legacy history data without provenance.
 */
export function getProvenanceTrends(cwd: string): ProvenanceTrends {
    const history = loadHistory(cwd);

    // Filter to runs that have provenance data (v5+ only)
    const withProvenance = history.runs.filter(r => r.provenance);
    const RECENT_WINDOW = 5;
    const MIN_BASELINE = 5;

    if (withProvenance.length < RECENT_WINDOW + MIN_BASELINE) {
        return {
            aiDrift: 'stable', structural: 'stable', security: 'stable',
            aiDriftZScore: 0, structuralZScore: 0, securityZScore: 0,
        };
    }

    // Non-overlapping windows (consistent with getQualityTrend)
    const recent = withProvenance.slice(-RECENT_WINDOW);
    const baseline = withProvenance.slice(0, -RECENT_WINDOW);

    const computeForField = (field: keyof ProvenanceRunData): { trend: QualityTrend; z: number } => {
        const baselineValues = baseline.map(r => r.provenance![field] ?? 0);
        const { mean, std } = meanAndStd(baselineValues);
        const recentAvg = recent.reduce((sum, r) => sum + (r.provenance![field] ?? 0), 0) / recent.length;
        const z = zScore(recentAvg, mean, std);
        return { trend: trendFromZScore(z), z: Math.round(z * 100) / 100 };
    };

    const ai = computeForField('aiDriftFailures');
    const structural = computeForField('structuralFailures');
    const security = computeForField('securityFailures');

    return {
        aiDrift: ai.trend,
        structural: structural.trend,
        security: security.trend,
        aiDriftZScore: ai.z,
        structuralZScore: structural.z,
        securityZScore: security.z,
    };
}

/**
 * Clear adaptive history (for testing)
 */
export function clearAdaptiveHistory(cwd: string): void {
    cachedHistory = null;
    const historyPath = path.join(cwd, '.rigour', 'adaptive-history.json');
    if (fs.existsSync(historyPath)) {
        fs.unlinkSync(historyPath);
    }
}
