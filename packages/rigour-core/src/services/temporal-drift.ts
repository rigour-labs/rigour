/**
 * Temporal Drift Engine (v5)
 *
 * The "bank statement" for code quality.
 * Reads from SQLite scan history and computes:
 *
 * 1. Cross-session temporal trends — how is quality changing over weeks/months?
 * 2. Per-provenance EWMA streams — is AI getting worse? Structural? Security?
 * 3. Anomaly detection — is today's scan statistically unusual?
 *
 * This is Rigour's core differentiator:
 * No other tool can tell a CTO "your AI contributions are degrading
 * your codebase at 3x the rate of human contributions."
 *
 * Data source: ~/.rigour/rigour.db (scans + findings tables)
 * All computation is read-only — no writes to DB.
 *
 */

import { openDatabase, type RigourDB } from '../storage/db.js';
import { Logger } from '../utils/logger.js';
import path from 'path';

// ─── Types ──────────────────────────────────────────────────────────

export type DriftDirection = 'improving' | 'stable' | 'degrading';

/** A single data point in a time series. */
export interface TrendPoint {
    timestamp: number;  // Unix ms
    value: number;
    ewma: number;
}

/** Per-provenance EWMA stream. */
export interface ProvenanceStream {
    direction: DriftDirection;
    zScore: number;
    /** EWMA time series (oldest first) */
    series: TrendPoint[];
    /** Current EWMA value */
    currentEWMA: number;
    /** Average over the full history */
    historicalAvg: number;
}

/** Monthly aggregation for the "3 months trend" view. */
export interface MonthlyBucket {
    month: string;  // "2026-01", "2026-02", etc.
    avgScore: number;
    avgAiHealth: number;
    avgStructural: number;
    scanCount: number;
    totalFailures: number;
    provenanceBreakdown: {
        aiDrift: number;
        structural: number;
        security: number;
    };
}

/** Weekly aggregation for more granular view. */
export interface WeeklyBucket {
    weekStart: string;  // ISO date of Monday
    avgScore: number;
    avgAiHealth: number;
    scanCount: number;
}

/** Complete temporal drift report for a project. */
export interface TemporalDriftReport {
    repo: string;
    totalScans: number;
    timeSpanDays: number;

    /** Overall quality trend direction */
    overallDirection: DriftDirection;
    overallZScore: number;

    /** Per-provenance EWMA streams — the core differentiator */
    streams: {
        aiDrift: ProvenanceStream;
        structural: ProvenanceStream;
        security: ProvenanceStream;
        overall: ProvenanceStream;
    };

    /** Monthly rollups for executive dashboard */
    monthly: MonthlyBucket[];

    /** Weekly rollups for team dashboard */
    weekly: WeeklyBucket[];

    /** Anomaly flag: is the latest scan statistically unusual? */
    latestScanAnomaly: {
        isAnomaly: boolean;
        direction: 'spike' | 'dip' | 'normal';
        zScore: number;
        message: string;
    };

    /** Human-readable narrative for the CTO question */
    narrative: string;
}

// ─── EWMA + Statistical Utilities ───────────────────────────────────

const DEFAULT_ALPHA = 0.3;

function computeEWMASeries(values: { timestamp: number; value: number }[], alpha = DEFAULT_ALPHA): TrendPoint[] {
    if (values.length === 0) return [];

    const series: TrendPoint[] = [];
    let ewma = values[0].value;

    for (const point of values) {
        ewma = alpha * point.value + (1 - alpha) * ewma;
        series.push({
            timestamp: point.timestamp,
            value: point.value,
            ewma: Math.round(ewma * 10) / 10,
        });
    }

    return series;
}

function meanAndStd(values: number[]): { mean: number; std: number } {
    if (values.length === 0) return { mean: 0, std: 0 };
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
    return { mean, std: Math.sqrt(variance) };
}

function zScore(value: number, mean: number, std: number): number {
    if (std === 0) return 0;
    return Math.round(((value - mean) / std) * 100) / 100;
}

function directionFromZ(z: number): DriftDirection {
    // For failure counts: positive Z = more failures = degrading
    if (z > 2.0) return 'degrading';
    if (z < -2.0) return 'improving';
    return 'stable';
}

function directionFromScoreZ(z: number): DriftDirection {
    // For scores: positive Z = higher score = improving
    if (z > 2.0) return 'improving';
    if (z < -2.0) return 'degrading';
    return 'stable';
}

// ─── Monthly/Weekly Bucketing ───────────────────────────────────────

function toMonthKey(timestamp: number): string {
    const d = new Date(timestamp);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function toWeekKey(timestamp: number): string {
    const d = new Date(timestamp);
    // Get Monday of this week (don't mutate d in-place)
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1);
    const monday = new Date(d);
    monday.setDate(diff);
    return monday.toISOString().split('T')[0];
}

// ─── Main Engine ────────────────────────────────────────────────────

/**
 * Generate a complete temporal drift report for a project.
 *
 * Reads from SQLite: scans (scores over time) + findings (provenance counts).
 * Computes EWMA streams, Z-scores, monthly/weekly rollups, and a narrative.
 *
 * @param cwd - Project root path (used to derive repo name)
 * @param maxScans - Max scans to analyze (default 200)
 */
export async function generateTemporalDriftReport(cwd: string, maxScans = 200): Promise<TemporalDriftReport | null> {
    const db = await openDatabase();
    if (!db) {
        Logger.warn('Temporal drift: SQLite not available');
        return null;
    }

    const repo = path.basename(cwd);

    try {
        // 1. Load all scans (oldest first)
        const scans = await db.all(`
            SELECT * FROM scans WHERE repo = ?
            ORDER BY timestamp ASC LIMIT ?
        `, repo, maxScans) as any[];

        if (scans.length < 3) {
            return createEmptyReport(repo, scans.length);
        }

        // 2. Load per-scan provenance failure counts
        const provenanceByScan = new Map<string, { aiDrift: number; structural: number; security: number }>();
        for (const scan of scans) {
            const counts = await db.all(`
                SELECT provenance, COUNT(*) as cnt FROM findings
                WHERE scan_id = ? GROUP BY provenance
            `, scan.id) as any[];

            const breakdown = { aiDrift: 0, structural: 0, security: 0 };
            for (const row of counts) {
                if (row.provenance === 'ai-drift') breakdown.aiDrift = row.cnt;
                else if (row.provenance === 'traditional') breakdown.structural = row.cnt;
                else if (row.provenance === 'security') breakdown.security = row.cnt;
            }
            provenanceByScan.set(scan.id, breakdown);
        }

        // 3. Build EWMA streams
        const overallStream = buildStream(
            scans.map(s => ({ timestamp: s.timestamp, value: s.overall_score ?? 100 })),
            true // higher score = better
        );

        const aiDriftStream = buildStream(
            scans.map(s => ({
                timestamp: s.timestamp,
                value: provenanceByScan.get(s.id)?.aiDrift ?? 0,
            })),
            false // higher count = worse
        );

        const structuralStream = buildStream(
            scans.map(s => ({
                timestamp: s.timestamp,
                value: provenanceByScan.get(s.id)?.structural ?? 0,
            })),
            false
        );

        const securityStream = buildStream(
            scans.map(s => ({
                timestamp: s.timestamp,
                value: provenanceByScan.get(s.id)?.security ?? 0,
            })),
            false
        );

        // 4. Monthly rollups
        const monthMap = new Map<string, MonthlyBucket>();
        for (const scan of scans) {
            const key = toMonthKey(scan.timestamp);
            const prov = provenanceByScan.get(scan.id) || { aiDrift: 0, structural: 0, security: 0 };

            if (!monthMap.has(key)) {
                monthMap.set(key, {
                    month: key,
                    avgScore: 0,
                    avgAiHealth: 0,
                    avgStructural: 0,
                    scanCount: 0,
                    totalFailures: 0,
                    provenanceBreakdown: { aiDrift: 0, structural: 0, security: 0 },
                });
            }
            const bucket = monthMap.get(key)!;
            bucket.scanCount++;
            bucket.avgScore += scan.overall_score ?? 100;
            bucket.avgAiHealth += scan.ai_health_score ?? 100;
            bucket.totalFailures += prov.aiDrift + prov.structural + prov.security;
            bucket.provenanceBreakdown.aiDrift += prov.aiDrift;
            bucket.provenanceBreakdown.structural += prov.structural;
            bucket.provenanceBreakdown.security += prov.security;
        }
        const monthly = Array.from(monthMap.values())
            .filter(b => b.scanCount > 0)
            .map(b => ({
                ...b,
                avgScore: Math.round(b.avgScore / b.scanCount),
                avgAiHealth: Math.round(b.avgAiHealth / b.scanCount),
                avgStructural: Math.round((100 - (b.provenanceBreakdown.structural / b.scanCount) * 5)),
            }));

        // 5. Weekly rollups
        const weekMap = new Map<string, WeeklyBucket>();
        for (const scan of scans) {
            const key = toWeekKey(scan.timestamp);
            if (!weekMap.has(key)) {
                weekMap.set(key, { weekStart: key, avgScore: 0, avgAiHealth: 0, scanCount: 0 });
            }
            const bucket = weekMap.get(key)!;
            bucket.scanCount++;
            bucket.avgScore += scan.overall_score ?? 100;
            bucket.avgAiHealth += scan.ai_health_score ?? 100;
        }
        const weekly = Array.from(weekMap.values())
            .filter(b => b.scanCount > 0)
            .map(b => ({
                ...b,
                avgScore: Math.round(b.avgScore / b.scanCount),
                avgAiHealth: Math.round(b.avgAiHealth / b.scanCount),
            }));

        // 6. Latest scan anomaly detection
        const recentScores = scans.slice(-20).map(s => s.overall_score ?? 100);
        const { mean, std } = meanAndStd(recentScores);
        const latestScore = scans[scans.length - 1].overall_score ?? 100;
        const latestZ = zScore(latestScore, mean, std);
        const latestAnomaly = {
            isAnomaly: Math.abs(latestZ) > 2.0,
            direction: latestZ > 2.0 ? 'spike' as const : latestZ < -2.0 ? 'dip' as const : 'normal' as const,
            zScore: latestZ,
            message: Math.abs(latestZ) > 2.0
                ? `Latest scan score (${latestScore}) is ${latestZ > 0 ? 'unusually high' : 'unusually low'} (Z=${latestZ})`
                : `Latest scan score (${latestScore}) is within normal range`,
        };

        // 7. Time span
        const firstTs = scans[0].timestamp;
        const lastTs = scans[scans.length - 1].timestamp;
        const timeSpanDays = Math.round((lastTs - firstTs) / (1000 * 60 * 60 * 24));

        // 8. Generate narrative
        const narrative = generateNarrative(
            repo, timeSpanDays, monthly, overallStream, aiDriftStream, structuralStream, securityStream
        );

        return {
            repo,
            totalScans: scans.length,
            timeSpanDays,
            overallDirection: overallStream.direction,
            overallZScore: overallStream.zScore,
            streams: {
                overall: overallStream,
                aiDrift: aiDriftStream,
                structural: structuralStream,
                security: securityStream,
            },
            monthly,
            weekly,
            latestScanAnomaly: latestAnomaly,
            narrative,
        };
    } catch (error) {
        Logger.warn(`Temporal drift generation failed: ${error}`);
        return null;
    } finally {
        await db.close();
    }
}

// ─── Helpers ────────────────────────────────────────────────────────

function buildStream(
    data: { timestamp: number; value: number }[],
    higherIsBetter: boolean
): ProvenanceStream {
    const series = computeEWMASeries(data);
    const values = data.map(d => d.value);
    const { mean, std } = meanAndStd(values);

    // Z-score of recent average (last 5) against full history
    const recentValues = values.slice(-5);
    const recentAvg = recentValues.length > 0
        ? recentValues.reduce((a, b) => a + b, 0) / recentValues.length
        : 0;
    const z = zScore(recentAvg, mean, std);

    const direction = higherIsBetter
        ? directionFromScoreZ(z)
        : directionFromZ(z); // for failure counts: positive Z = more = degrading

    return {
        direction,
        zScore: z,
        series,
        currentEWMA: series.length > 0 ? series[series.length - 1].ewma : 0,
        historicalAvg: Math.round(mean * 10) / 10,
    };
}

function createEmptyReport(repo: string, scanCount: number): TemporalDriftReport {
    const emptyStream: ProvenanceStream = {
        direction: 'stable', zScore: 0, series: [], currentEWMA: 0, historicalAvg: 0,
    };
    return {
        repo,
        totalScans: scanCount,
        timeSpanDays: 0,
        overallDirection: 'stable',
        overallZScore: 0,
        streams: {
            overall: emptyStream,
            aiDrift: { ...emptyStream },
            structural: { ...emptyStream },
            security: { ...emptyStream },
        },
        monthly: [],
        weekly: [],
        latestScanAnomaly: { isAnomaly: false, direction: 'normal', zScore: 0, message: 'Not enough data' },
        narrative: `${repo}: Only ${scanCount} scans recorded. Need at least 3 for trend analysis.`,
    };
}

/**
 * Generate the human-readable narrative that answers:
 * "3 mahine mein hum better hue ya worse?"
 */
function generateNarrative(
    repo: string,
    days: number,
    monthly: MonthlyBucket[],
    overall: ProvenanceStream,
    aiDrift: ProvenanceStream,
    structural: ProvenanceStream,
    security: ProvenanceStream
): string {
    const parts: string[] = [];

    // Time span
    if (days > 30) {
        parts.push(`Over the last ${Math.round(days / 30)} months`);
    } else {
        parts.push(`Over the last ${days} days`);
    }

    // Overall direction
    if (overall.direction === 'improving') {
        parts.push(`${repo} quality is IMPROVING (score trending up, Z=${overall.zScore}).`);
    } else if (overall.direction === 'degrading') {
        parts.push(`${repo} quality is DEGRADING (score trending down, Z=${overall.zScore}).`);
    } else {
        parts.push(`${repo} quality is STABLE.`);
    }

    // Per-provenance diagnosis
    const problems: string[] = [];
    if (aiDrift.direction === 'degrading') {
        problems.push(`AI-generated code is getting worse (Z=${aiDrift.zScore}) — agents are producing more drift`);
    }
    if (structural.direction === 'degrading') {
        problems.push(`Structural code quality is declining (Z=${structural.zScore}) — team may be taking shortcuts`);
    }
    if (security.direction === 'degrading') {
        problems.push(`Security posture is weakening (Z=${security.zScore}) — credential/vulnerability issues increasing`);
    }

    if (problems.length > 0) {
        parts.push('Root causes: ' + problems.join('; ') + '.');
    }

    // Monthly progression
    if (monthly.length >= 2) {
        const first = monthly[0];
        const last = monthly[monthly.length - 1];
        const scoreDelta = last.avgScore - first.avgScore;
        const failDelta = last.totalFailures / last.scanCount - first.totalFailures / first.scanCount;

        if (Math.abs(scoreDelta) > 5) {
            parts.push(
                `Monthly avg score: ${first.avgScore} (${first.month}) → ${last.avgScore} (${last.month}), ` +
                `delta ${scoreDelta > 0 ? '+' : ''}${scoreDelta}.`
            );
        }

        if (Math.abs(failDelta) > 1) {
            parts.push(
                `Avg failures/scan: ${(first.totalFailures / first.scanCount).toFixed(1)} → ${(last.totalFailures / last.scanCount).toFixed(1)}.`
            );
        }
    }

    // Bright spots
    const improvements: string[] = [];
    if (aiDrift.direction === 'improving') improvements.push('AI drift reducing');
    if (structural.direction === 'improving') improvements.push('structural quality improving');
    if (security.direction === 'improving') improvements.push('security posture strengthening');
    if (improvements.length > 0) {
        parts.push('Bright spots: ' + improvements.join(', ') + '.');
    }

    return parts.join(' ');
}

/**
 * Get a formatted summary string for CLI/MCP output.
 */
export function formatDriftSummary(report: TemporalDriftReport): string {
    const lines: string[] = [];

    lines.push(`═══ Temporal Drift: ${report.repo} (${report.totalScans} scans, ${report.timeSpanDays} days) ═══`);
    lines.push('');

    // EWMA Streams
    const bar = (direction: DriftDirection): string => {
        switch (direction) {
            case 'improving': return '████████░░  IMPROVING';
            case 'stable':    return '█████░░░░░  stable';
            case 'degrading': return '██░░░░░░░░  DEGRADING';
            default:          return '░░░░░░░░░░  unknown';
        }
    };

    lines.push('Per-Provenance Health:');
    lines.push(`  AI Drift:    ${bar(report.streams.aiDrift.direction)} (Z=${report.streams.aiDrift.zScore})`);
    lines.push(`  Structural:  ${bar(report.streams.structural.direction)} (Z=${report.streams.structural.zScore})`);
    lines.push(`  Security:    ${bar(report.streams.security.direction)} (Z=${report.streams.security.zScore})`);
    lines.push(`  Overall:     ${bar(report.streams.overall.direction)} (Z=${report.streams.overall.zScore})`);
    lines.push('');

    // Monthly trend
    if (report.monthly.length > 0) {
        lines.push('Monthly Trend:');
        for (const m of report.monthly.slice(-6)) {
            const failPerScan = (m.totalFailures / m.scanCount).toFixed(1);
            lines.push(`  ${m.month}: score=${m.avgScore}, failures/scan=${failPerScan}, scans=${m.scanCount}`);
        }
        lines.push('');
    }

    // Anomaly
    if (report.latestScanAnomaly.isAnomaly) {
        lines.push(`WARNING: ${report.latestScanAnomaly.message}`);
        lines.push('');
    }

    // Narrative
    lines.push(report.narrative);

    return lines.join('\n');
}
