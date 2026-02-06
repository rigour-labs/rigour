/**
 * Adaptive Thresholds Service
 * 
 * Dynamically adjusts quality gate thresholds based on:
 * - Project maturity (age, commit count, file count)
 * - Historical failure rates
 * - Complexity tier (hobby/startup/enterprise)
 * - Recent trends (improving/degrading)
 * 
 * This enables Rigour to be "strict but fair" - new projects get
 * more lenient thresholds while mature codebases are held to higher standards.
 * 
 * @since v2.14.0
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
}

// Historical failure data (persisted to .rigour/adaptive-history.json)
interface FailureHistory {
    runs: {
        timestamp: string;
        passedGates: number;
        failedGates: number;
        totalFailures: number;
    }[];
    lastUpdated: string;
}

let cachedHistory: FailureHistory | null = null;

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

/**
 * Record a gate run for historical tracking
 */
export function recordGateRun(
    cwd: string,
    passedGates: number,
    failedGates: number,
    totalFailures: number
): void {
    const history = loadHistory(cwd);
    history.runs.push({
        timestamp: new Date().toISOString(),
        passedGates,
        failedGates,
        totalFailures,
    });

    // Keep last 100 runs
    if (history.runs.length > 100) {
        history.runs = history.runs.slice(-100);
    }

    history.lastUpdated = new Date().toISOString();
    saveHistory(cwd, history);
}

/**
 * Get quality trend from historical data
 */
export function getQualityTrend(cwd: string): QualityTrend {
    const history = loadHistory(cwd);
    if (history.runs.length < 5) return 'stable';

    const recent = history.runs.slice(-10);
    const older = history.runs.slice(-20, -10);

    if (older.length === 0) return 'stable';

    const recentFailRate = recent.reduce((sum, r) => sum + r.totalFailures, 0) / recent.length;
    const olderFailRate = older.reduce((sum, r) => sum + r.totalFailures, 0) / older.length;

    const delta = recentFailRate - olderFailRate;

    if (delta < -2) return 'improving';
    if (delta > 2) return 'degrading';
    return 'stable';
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
 * Calculate adaptive thresholds based on project state
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

    // Get trend
    const trend = getQualityTrend(cwd);
    reasoning.push(`Quality trend: ${trend}`);

    // Base thresholds
    let coverageThreshold = config.base_coverage_threshold ?? 80;
    let qualityThreshold = config.base_quality_threshold ?? 80;
    let securityBlockLevel: 'critical' | 'high' | 'medium' | 'low' = 'high';
    let leniencyFactor = 0.5;

    // Adjust by tier
    switch (tier) {
        case 'hobby':
            // Lenient for small/new projects
            coverageThreshold = Math.max(50, coverageThreshold - 30);
            qualityThreshold = Math.max(60, qualityThreshold - 20);
            securityBlockLevel = 'critical'; // Only block on critical
            leniencyFactor = 0.8;
            reasoning.push('Hobby tier: relaxed thresholds, only critical security blocks');
            break;

        case 'startup':
            // Moderate strictness
            coverageThreshold = Math.max(60, coverageThreshold - 15);
            qualityThreshold = Math.max(70, qualityThreshold - 10);
            securityBlockLevel = 'high';
            leniencyFactor = 0.5;
            reasoning.push('Startup tier: moderate thresholds, high+ security blocks');
            break;

        case 'enterprise':
            // Strict standards
            coverageThreshold = coverageThreshold;
            qualityThreshold = qualityThreshold;
            securityBlockLevel = 'medium';
            leniencyFactor = 0.2;
            reasoning.push('Enterprise tier: strict thresholds, medium+ security blocks');
            break;
    }

    // Adjust by trend
    if (trend === 'improving') {
        // Reward improvement with slightly relaxed thresholds
        coverageThreshold = Math.max(50, coverageThreshold - 5);
        qualityThreshold = Math.max(60, qualityThreshold - 5);
        leniencyFactor = Math.min(1, leniencyFactor + 0.1);
        reasoning.push('Improving trend: bonus threshold relaxation (+5%)');
    } else if (trend === 'degrading') {
        // Tighten thresholds to encourage recovery
        coverageThreshold = Math.min(95, coverageThreshold + 5);
        qualityThreshold = Math.min(95, qualityThreshold + 5);
        leniencyFactor = Math.max(0, leniencyFactor - 0.1);
        reasoning.push('Degrading trend: tightened thresholds (-5%)');
    }

    // Recent failure rate adjustment
    if (metrics.recentFailureRate !== undefined) {
        if (metrics.recentFailureRate > 50) {
            // High failure rate - be more lenient to avoid discouragement
            leniencyFactor = Math.min(1, leniencyFactor + 0.2);
            reasoning.push(`High failure rate (${metrics.recentFailureRate.toFixed(0)}%): increased leniency`);
        } else if (metrics.recentFailureRate < 10) {
            // Low failure rate - team is mature, can handle stricter gates
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
    return `[${adjustments.tier.toUpperCase()}] ` +
        `Coverage: ${adjustments.coverageThreshold}%, ` +
        `Quality: ${adjustments.qualityThreshold}%, ` +
        `Security: ${adjustments.securityBlockLevel}+, ` +
        `Trend: ${adjustments.trend}`;
}
