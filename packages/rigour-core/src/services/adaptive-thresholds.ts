/**
 * Adaptive Thresholds Service (v2)
 *
 * Dynamically adjusts quality gate thresholds based on:
 * - Project maturity (age, commit count, file count)
 * - Historical failure rates with Z-score anomaly detection
 * - Complexity tier (hobby/startup/enterprise)
 * - Per-provenance trend analysis (ai-drift, structural, security separate)
 *
 * v2 upgrades:
 * - Z-score replaces naive delta comparison for trend detection
 * - Per-provenance failure tracking (AI drift vs structural vs security)
 * - Statistical anomaly detection normalizes across project sizes
 *
 */

import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../utils/logger.js';

export type ComplexityTier = 'hobby' | 'startup' | 'enterprise';
export type QualityTrend = 'improving' | 'stable' | 'degrading';

export interface ProjectMetrics {
    fileCount: number;
    commitCount?: number;
    ageInDays?: number;
    testCoverage?: number;
    recentFailureRate?: number;
}

export interface AdaptiveConfig {
    enabled?: boolean;
    base_coverage_threshold?: number;
    base_quality_threshold?: number;
    auto_detect_tier?: boolean;
    forced_tier?: ComplexityTier;
}

export interface ThresholdAdjustments {
    tier: ComplexityTier;
    trend: QualityTrend;
    coverageThreshold: number;
    qualityThreshold: number;
    securityBlockLevel: 'critical' | 'high' | 'medium' | 'low';
    leniencyFactor: number; // 0.0 = strict, 1.0 = lenient
    reasoning: string[];
    /** Per-provenance trend breakdown (new in v5) */
    provenanceTrends?: ProvenanceTrends;
}

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
 * Detect project complexity tier based on metrics
 */
export function detectComplexityTier(metrics: ProjectMetrics): ComplexityTier {
    // Enterprise: Large teams, many files, mature codebase
    if (metrics.fileCount > 500 || (metrics.commitCount && metrics.commitCount > 1000)) {
        return 'enterprise';
    }

    // Startup: Growing codebase, active development
    if (metrics.fileCount > 50 || (metrics.commitCount && metrics.commitCount > 100)) {
        return 'startup';
    }

    // Hobby: Small projects, early stage
    return 'hobby';
}

/**
 * Calculate adaptive thresholds based on project state.
 * v5: Uses Z-score trending and per-provenance analysis.
 */
export function calculateAdaptiveThresholds(
    cwd: string,
    metrics: ProjectMetrics,
    config: AdaptiveConfig = {}
): ThresholdAdjustments {
    const reasoning: string[] = [];

    // Determine tier
    const tier = config.forced_tier ??
        (config.auto_detect_tier !== false ? detectComplexityTier(metrics) : 'startup');
    reasoning.push(`Complexity tier: ${tier} (files: ${metrics.fileCount})`);

    // Get overall trend (Z-score based)
    const trend = getQualityTrend(cwd);
    reasoning.push(`Quality trend: ${trend} (Z-score analysis)`);

    // Get per-provenance trends
    const provenanceTrends = getProvenanceTrends(cwd);
    if (provenanceTrends.aiDrift !== 'stable') {
        reasoning.push(`AI drift trend: ${provenanceTrends.aiDrift} (Z=${provenanceTrends.aiDriftZScore})`);
    }
    if (provenanceTrends.structural !== 'stable') {
        reasoning.push(`Structural trend: ${provenanceTrends.structural} (Z=${provenanceTrends.structuralZScore})`);
    }
    if (provenanceTrends.security !== 'stable') {
        reasoning.push(`Security trend: ${provenanceTrends.security} (Z=${provenanceTrends.securityZScore})`);
    }

    // Base thresholds
    let coverageThreshold = config.base_coverage_threshold ?? 80;
    let qualityThreshold = config.base_quality_threshold ?? 80;
    let securityBlockLevel: 'critical' | 'high' | 'medium' | 'low' = 'high';
    let leniencyFactor = 0.5;

    // Adjust by tier
    switch (tier) {
        case 'hobby':
            coverageThreshold = Math.max(50, coverageThreshold - 30);
            qualityThreshold = Math.max(60, qualityThreshold - 20);
            securityBlockLevel = 'critical';
            leniencyFactor = 0.8;
            reasoning.push('Hobby tier: relaxed thresholds, only critical security blocks');
            break;

        case 'startup':
            coverageThreshold = Math.max(60, coverageThreshold - 15);
            qualityThreshold = Math.max(70, qualityThreshold - 10);
            securityBlockLevel = 'high';
            leniencyFactor = 0.5;
            reasoning.push('Startup tier: moderate thresholds, high+ security blocks');
            break;

        case 'enterprise':
            coverageThreshold = coverageThreshold;
            qualityThreshold = qualityThreshold;
            securityBlockLevel = 'medium';
            leniencyFactor = 0.2;
            reasoning.push('Enterprise tier: strict thresholds, medium+ security blocks');
            break;
    }

    // Adjust by overall trend
    if (trend === 'improving') {
        coverageThreshold = Math.max(50, coverageThreshold - 5);
        qualityThreshold = Math.max(60, qualityThreshold - 5);
        leniencyFactor = Math.min(1, leniencyFactor + 0.1);
        reasoning.push('Improving trend: bonus threshold relaxation (+5%)');
    } else if (trend === 'degrading') {
        coverageThreshold = Math.min(95, coverageThreshold + 5);
        qualityThreshold = Math.min(95, qualityThreshold + 5);
        leniencyFactor = Math.max(0, leniencyFactor - 0.1);
        reasoning.push('Degrading trend: tightened thresholds (-5%)');
    }

    // v5: Per-provenance adjustments
    // If AI drift is degrading but structural is stable, tighten AI-specific gates
    if (provenanceTrends.aiDrift === 'degrading' && provenanceTrends.structural !== 'degrading') {
        leniencyFactor = Math.max(0, leniencyFactor - 0.15);
        reasoning.push('AI drift degrading while structural stable: AI is the problem, tightening AI gates');
    }
    // If security is degrading, escalate security block level
    if (provenanceTrends.security === 'degrading') {
        if (securityBlockLevel === 'critical') securityBlockLevel = 'high';
        else if (securityBlockLevel === 'high') securityBlockLevel = 'medium';
        reasoning.push(`Security trend degrading: escalated block level to ${securityBlockLevel}+`);
    }

    // Recent failure rate adjustment
    if (metrics.recentFailureRate !== undefined) {
        if (metrics.recentFailureRate > 50) {
            leniencyFactor = Math.min(1, leniencyFactor + 0.2);
            reasoning.push(`High failure rate (${metrics.recentFailureRate.toFixed(0)}%): increased leniency`);
        } else if (metrics.recentFailureRate < 10) {
            leniencyFactor = Math.max(0, leniencyFactor - 0.1);
            reasoning.push(`Low failure rate (${metrics.recentFailureRate.toFixed(0)}%): stricter enforcement`);
        }
    }

    return {
        tier,
        trend,
        coverageThreshold: Math.round(coverageThreshold),
        qualityThreshold: Math.round(qualityThreshold),
        securityBlockLevel,
        leniencyFactor: Math.round(leniencyFactor * 100) / 100,
        reasoning,
        provenanceTrends,
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

/**
 * Get summary of adaptive thresholds for logging
 */
export function getAdaptiveSummary(adjustments: ThresholdAdjustments): string {
    let summary = `[${adjustments.tier.toUpperCase()}] ` +
        `Coverage: ${adjustments.coverageThreshold}%, ` +
        `Quality: ${adjustments.qualityThreshold}%, ` +
        `Security: ${adjustments.securityBlockLevel}+, ` +
        `Trend: ${adjustments.trend}`;

    if (adjustments.provenanceTrends) {
        const pt = adjustments.provenanceTrends;
        if (pt.aiDrift !== 'stable' || pt.structural !== 'stable' || pt.security !== 'stable') {
            summary += ` | AI:${pt.aiDrift}(Z=${pt.aiDriftZScore}) Struct:${pt.structural}(Z=${pt.structuralZScore}) Sec:${pt.security}(Z=${pt.securityZScore})`;
        }
    }

    return summary;
}
