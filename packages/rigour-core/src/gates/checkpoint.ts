/**
 * Checkpoint Supervision Gate (v2)
 *
 * Monitors agent quality during extended execution for frontier models
 * like GPT-5.3-Codex "coworking mode" that run autonomously for long periods.
 *
 * v2 upgrades:
 * - EWMA (Exponentially Weighted Moving Average) replaces linear regression
 * - One bad checkpoint no longer tanks the whole trend
 * - Configurable smoothing factor (α=0.3 default — recent data weighted more)
 * - Separate "sudden drop" detection from "gradual decline" detection
 *
 * EWMA formula:
 *   ewma_t = α × score_t + (1 - α) × ewma_(t-1)
 *
 * Why EWMA > Linear Regression:
 * - Linear regression on 5 points: one outlier shifts the slope dramatically
 * - EWMA: one bad score dampened by history, persistent drops amplified
 * - α=0.3: ~70% weight on history, 30% on new data → noise-resistant
 *
 * @since v2.14.0 (original, linear regression)
 * @since v5.0.0  (EWMA drift detection)
 */

import { Gate, GateContext } from './base.js';
import { Failure, Provenance } from '../types/index.js';
import { Logger } from '../utils/logger.js';
import * as fs from 'fs';
import * as path from 'path';

export interface CheckpointEntry {
    checkpointId: string;
    timestamp: Date;
    progressPct: number;
    filesChanged: string[];
    summary: string;
    qualityScore: number;
    warnings: string[];
    /** EWMA value at this checkpoint (computed on record) */
    ewma?: number;
}

export interface CheckpointSession {
    sessionId: string;
    startedAt: Date;
    lastCheckpoint?: Date;
    checkpoints: CheckpointEntry[];
    status: 'active' | 'completed' | 'aborted';
}

export interface CheckpointConfig {
    enabled?: boolean;
    interval_minutes?: number;
    quality_threshold?: number;
    drift_detection?: boolean;
    auto_save_on_failure?: boolean;
    /** EWMA smoothing factor. Higher = more weight on recent data. Default 0.3 */
    ewma_alpha?: number;
    /** Drop from EWMA that triggers drift warning. Default 15 */
    drift_drop_threshold?: number;
}

// In-memory checkpoint store (persisted to .rigour/checkpoint-session.json)
let currentCheckpointSession: CheckpointSession | null = null;

/**
 * Generate unique checkpoint ID
 */
function generateCheckpointId(): string {
    return `cp-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
}

// ─── EWMA Computation ──────────────────────────────────────────────

/**
 * Compute EWMA for a new data point.
 *
 * ewma_t = α × value + (1 - α) × ewma_(t-1)
 *
 * For the first data point, ewma = value (no history to smooth against).
 */
function computeEWMA(value: number, previousEWMA: number | undefined, alpha: number): number {
    if (previousEWMA === undefined) return value;
    return alpha * value + (1 - alpha) * previousEWMA;
}

/**
 * Detect quality drift using EWMA.
 *
 * Two-signal detection:
 *
 * 1. Sudden Drop: Current score is significantly below the EWMA.
 *    This catches "agent suddenly started producing garbage."
 *    Threshold: score < ewma - drift_drop_threshold
 *
 * 2. Gradual Decline: EWMA itself is trending downward.
 *    Compare current EWMA to EWMA from N checkpoints ago.
 *    This catches "agent is slowly getting worse over 30 minutes."
 *    Threshold: ewma_now < ewma_5ago - drift_drop_threshold
 *
 * Returns trend assessment and whether drift alarm should fire.
 */
function detectDrift(
    checkpoints: CheckpointEntry[],
    alpha: number,
    dropThreshold: number
): { hasDrift: boolean; trend: 'improving' | 'stable' | 'degrading'; ewma: number; reason?: string } {
    if (checkpoints.length < 3) {
        return { hasDrift: false, trend: 'stable', ewma: checkpoints.length > 0 ? checkpoints[checkpoints.length - 1].qualityScore : 0 };
    }

    // Recompute EWMA chain to ensure consistency
    let ewma = checkpoints[0].qualityScore;
    for (let i = 1; i < checkpoints.length; i++) {
        ewma = computeEWMA(checkpoints[i].qualityScore, ewma, alpha);
    }

    const currentScore = checkpoints[checkpoints.length - 1].qualityScore;

    // Signal 1: Sudden drop from smoothed average
    if (currentScore < ewma - dropThreshold) {
        return {
            hasDrift: true,
            trend: 'degrading',
            ewma,
            reason: `Sudden quality drop: score ${currentScore}% vs EWMA ${ewma.toFixed(1)}% (gap: ${(ewma - currentScore).toFixed(1)})`,
        };
    }

    // Signal 2: Gradual EWMA decline (compare to EWMA 5 checkpoints ago)
    if (checkpoints.length >= 6) {
        let ewmaAt5Ago = checkpoints[0].qualityScore;
        const stopAt = checkpoints.length - 5;
        for (let i = 1; i <= stopAt; i++) {
            ewmaAt5Ago = computeEWMA(checkpoints[i].qualityScore, ewmaAt5Ago, alpha);
        }

        if (ewma < ewmaAt5Ago - dropThreshold) {
            return {
                hasDrift: true,
                trend: 'degrading',
                ewma,
                reason: `Gradual decline: EWMA dropped from ${ewmaAt5Ago.toFixed(1)}% to ${ewma.toFixed(1)}% over last 5 checkpoints`,
            };
        }

        if (ewma > ewmaAt5Ago + dropThreshold) {
            return { hasDrift: false, trend: 'improving', ewma };
        }
    }

    return { hasDrift: false, trend: 'stable', ewma };
}

// ─── Session Management ─────────────────────────────────────────────

/**
 * Get or create checkpoint session
 */
export function getOrCreateCheckpointSession(cwd: string): CheckpointSession {
    if (!currentCheckpointSession) {
        loadCheckpointSession(cwd);
    }
    if (!currentCheckpointSession) {
        currentCheckpointSession = {
            sessionId: `chk-session-${Date.now()}`,
            startedAt: new Date(),
            checkpoints: [],
            status: 'active',
        };
        persistCheckpointSession(cwd);
    }
    return currentCheckpointSession;
}

/**
 * Record a checkpoint with quality evaluation
 */
export function recordCheckpoint(
    cwd: string,
    progressPct: number,
    filesChanged: string[],
    summary: string,
    qualityScore: number,
    config?: CheckpointConfig
): { continue: boolean; warnings: string[]; checkpoint: CheckpointEntry } {
    const session = getOrCreateCheckpointSession(cwd);
    const warnings: string[] = [];
    const alpha = config?.ewma_alpha ?? 0.3;

    const qualityThreshold = config?.quality_threshold ?? 80;

    // Check if quality is below threshold
    const shouldContinue = qualityScore >= qualityThreshold;
    if (!shouldContinue) {
        warnings.push(`Quality score ${qualityScore}% is below threshold ${qualityThreshold}%`);
    }

    // Compute EWMA for this checkpoint
    const previousEWMA = session.checkpoints.length > 0
        ? session.checkpoints[session.checkpoints.length - 1].ewma
        : undefined;
    const currentEWMA = computeEWMA(qualityScore, previousEWMA, alpha);

    // Detect drift using EWMA
    if (session.checkpoints.length >= 2) {
        const dropThreshold = config?.drift_drop_threshold ?? 15;
        // Temporarily add this checkpoint for drift analysis
        const tempCheckpoints = [...session.checkpoints, { qualityScore } as CheckpointEntry];
        const { hasDrift, reason } = detectDrift(tempCheckpoints, alpha, dropThreshold);
        if (hasDrift && reason) {
            warnings.push(reason);
        }
    }

    const checkpoint: CheckpointEntry = {
        checkpointId: generateCheckpointId(),
        timestamp: new Date(),
        progressPct,
        filesChanged,
        summary,
        qualityScore,
        warnings,
        ewma: Math.round(currentEWMA * 10) / 10,
    };

    session.checkpoints.push(checkpoint);
    session.lastCheckpoint = new Date();
    persistCheckpointSession(cwd);

    return { continue: shouldContinue, warnings, checkpoint };
}

/**
 * Get current checkpoint session
 */
export function getCheckpointSession(cwd: string): CheckpointSession | null {
    if (!currentCheckpointSession) {
        loadCheckpointSession(cwd);
    }
    return currentCheckpointSession;
}

/**
 * Complete checkpoint session
 */
export function completeCheckpointSession(cwd: string): void {
    if (currentCheckpointSession) {
        currentCheckpointSession.status = 'completed';
        persistCheckpointSession(cwd);
    }
}

/**
 * Abort checkpoint session (quality too low)
 */
export function abortCheckpointSession(cwd: string, reason: string): void {
    if (currentCheckpointSession) {
        currentCheckpointSession.status = 'aborted';
        currentCheckpointSession.checkpoints.push({
            checkpointId: generateCheckpointId(),
            timestamp: new Date(),
            progressPct: currentCheckpointSession.checkpoints.length > 0
                ? currentCheckpointSession.checkpoints[currentCheckpointSession.checkpoints.length - 1].progressPct
                : 0,
            filesChanged: [],
            summary: `Session aborted: ${reason}`,
            qualityScore: 0,
            warnings: [reason],
        });
        persistCheckpointSession(cwd);
    }
}

/**
 * Clear checkpoint session
 */
export function clearCheckpointSession(cwd: string): void {
    currentCheckpointSession = null;
    const sessionPath = path.join(cwd, '.rigour', 'checkpoint-session.json');
    if (fs.existsSync(sessionPath)) {
        fs.unlinkSync(sessionPath);
    }
}

function persistCheckpointSession(cwd: string): void {
    const rigourDir = path.join(cwd, '.rigour');
    if (!fs.existsSync(rigourDir)) {
        fs.mkdirSync(rigourDir, { recursive: true });
    }
    const sessionPath = path.join(rigourDir, 'checkpoint-session.json');
    fs.writeFileSync(sessionPath, JSON.stringify(currentCheckpointSession, null, 2));
}

function loadCheckpointSession(cwd: string): void {
    const sessionPath = path.join(cwd, '.rigour', 'checkpoint-session.json');
    if (fs.existsSync(sessionPath)) {
        try {
            const data = JSON.parse(fs.readFileSync(sessionPath, 'utf-8'));
            currentCheckpointSession = {
                ...data,
                startedAt: new Date(data.startedAt),
                lastCheckpoint: data.lastCheckpoint ? new Date(data.lastCheckpoint) : undefined,
                checkpoints: data.checkpoints.map((cp: any) => ({
                    ...cp,
                    timestamp: new Date(cp.timestamp),
                })),
            };
        } catch (err) {
            Logger.warn('Failed to load checkpoint session, starting fresh');
            currentCheckpointSession = null;
        }
    }
}

/**
 * Calculate time since last checkpoint
 */
function timeSinceLastCheckpoint(session: CheckpointSession): number {
    const lastTime = session.lastCheckpoint || session.startedAt;
    return (Date.now() - lastTime.getTime()) / 1000 / 60; // minutes
}

// ─── Gate Implementation ────────────────────────────────────────────

export class CheckpointGate extends Gate {
    private config: CheckpointConfig;

    constructor(config: CheckpointConfig = {}) {
        super('checkpoint', 'Checkpoint Supervision');
        this.config = {
            enabled: config.enabled ?? false,
            interval_minutes: config.interval_minutes ?? 15,
            quality_threshold: config.quality_threshold ?? 80,
            drift_detection: config.drift_detection ?? true,
            auto_save_on_failure: config.auto_save_on_failure ?? true,
            ewma_alpha: config.ewma_alpha ?? 0.3,
            drift_drop_threshold: config.drift_drop_threshold ?? 15,
        };
    }

    protected get provenance(): Provenance { return 'governance'; }

    async run(context: GateContext): Promise<Failure[]> {
        if (!this.config.enabled) {
            return [];
        }

        const failures: Failure[] = [];
        const session = getCheckpointSession(context.cwd);

        if (!session || session.checkpoints.length === 0) {
            return [];
        }

        Logger.info(`Checkpoint Gate: ${session.checkpoints.length} checkpoints in session`);

        // Check 1: Time since last checkpoint
        const minutesSinceLast = timeSinceLastCheckpoint(session);
        if (minutesSinceLast > (this.config.interval_minutes ?? 15) * 2) {
            failures.push(this.createFailure(
                `No checkpoint in ${minutesSinceLast.toFixed(0)} minutes (expected every ${this.config.interval_minutes} min)`,
                undefined,
                'Ensure agent is reporting checkpoints via rigour_checkpoint MCP tool',
                'Missing Checkpoint'
            ));
        }

        // Check 2: Quality threshold
        const lastCheckpoint = session.checkpoints[session.checkpoints.length - 1];
        if (lastCheckpoint.qualityScore < (this.config.quality_threshold ?? 80)) {
            failures.push(this.createFailure(
                `Quality score ${lastCheckpoint.qualityScore}% is below threshold ${this.config.quality_threshold}%`,
                lastCheckpoint.filesChanged,
                'Review recent changes and address quality issues before continuing',
                'Quality Below Threshold',
                undefined,
                undefined,
                'high'
            ));
        }

        // Check 3: EWMA-based drift detection (v5)
        if (this.config.drift_detection) {
            const { hasDrift, trend, ewma, reason } = detectDrift(
                session.checkpoints,
                this.config.ewma_alpha ?? 0.3,
                this.config.drift_drop_threshold ?? 15
            );

            if (hasDrift && trend === 'degrading') {
                failures.push(this.createFailure(
                    `Quality drift detected (EWMA: ${ewma.toFixed(1)}%): ${reason || 'scores are degrading over time'}`,
                    undefined,
                    'Agent performance is declining. Consider pausing and reviewing recent work.',
                    'Quality Drift Detected',
                    undefined,
                    undefined,
                    'high'
                ));
            }
        }

        return failures;
    }
}
