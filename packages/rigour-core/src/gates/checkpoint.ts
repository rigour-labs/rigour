/**
 * Checkpoint Supervision Gate
 * 
 * Monitors agent quality during extended execution for frontier models
 * like GPT-5.3-Codex "coworking mode" that run autonomously for long periods.
 * 
 * Features:
 * - Time-based checkpoint triggers
 * - Quality score tracking
 * - Drift detection (quality degradation over time)
 * - Auto-save on failure
 * 
 * @since v2.14.0
 */

import { Gate, GateContext } from './base.js';
import { Failure } from '../types/index.js';
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
}

// In-memory checkpoint store (persisted to .rigour/checkpoint-session.json)
let currentCheckpointSession: CheckpointSession | null = null;

/**
 * Generate unique checkpoint ID
 */
function generateCheckpointId(): string {
    return `cp-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
}

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
    qualityScore: number
): { continue: boolean; warnings: string[]; checkpoint: CheckpointEntry } {
    const session = getOrCreateCheckpointSession(cwd);
    const warnings: string[] = [];

    // Default threshold
    const qualityThreshold = 80;

    // Check if quality is below threshold
    const shouldContinue = qualityScore >= qualityThreshold;
    if (!shouldContinue) {
        warnings.push(`Quality score ${qualityScore}% is below threshold ${qualityThreshold}%`);
    }

    // Detect drift (quality degradation over recent checkpoints)
    if (session.checkpoints.length >= 2) {
        const recentScores = session.checkpoints.slice(-3).map(cp => cp.qualityScore);
        const avgRecent = recentScores.reduce((a, b) => a + b, 0) / recentScores.length;

        if (qualityScore < avgRecent - 10) {
            warnings.push(`Drift detected: quality dropped from avg ${avgRecent.toFixed(0)}% to ${qualityScore}%`);
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
        // Add final checkpoint with abort reason
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

/**
 * Detect quality drift pattern
 */
function detectDrift(checkpoints: CheckpointEntry[]): { hasDrift: boolean; trend: 'improving' | 'stable' | 'degrading' } {
    if (checkpoints.length < 3) {
        return { hasDrift: false, trend: 'stable' };
    }

    const recent = checkpoints.slice(-5);
    const scores = recent.map(cp => cp.qualityScore);

    // Calculate trend using simple linear regression
    const n = scores.length;
    const sumX = (n * (n - 1)) / 2;
    const sumY = scores.reduce((a, b) => a + b, 0);
    const sumXY = scores.reduce((sum, y, x) => sum + x * y, 0);
    const sumX2 = (n * (n - 1) * (2 * n - 1)) / 6;

    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);

    if (slope < -2) {
        return { hasDrift: true, trend: 'degrading' };
    } else if (slope > 2) {
        return { hasDrift: false, trend: 'improving' };
    }
    return { hasDrift: false, trend: 'stable' };
}

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
        };
    }

    async run(context: GateContext): Promise<Failure[]> {
        if (!this.config.enabled) {
            return [];
        }

        const failures: Failure[] = [];
        const session = getCheckpointSession(context.cwd);

        if (!session || session.checkpoints.length === 0) {
            // No checkpoints yet, skip
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
                'Quality Below Threshold'
            ));
        }

        // Check 3: Drift detection
        if (this.config.drift_detection) {
            const { hasDrift, trend } = detectDrift(session.checkpoints);
            if (hasDrift && trend === 'degrading') {
                failures.push(this.createFailure(
                    `Quality drift detected: scores are degrading over time`,
                    undefined,
                    'Agent performance is declining. Consider pausing and reviewing recent work.',
                    'Quality Drift Detected'
                ));
            }
        }

        return failures;
    }
}
