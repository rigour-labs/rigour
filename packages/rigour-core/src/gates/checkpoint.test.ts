import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
    CheckpointGate,
    recordCheckpoint,
    getCheckpointSession,
    clearCheckpointSession,
    getOrCreateCheckpointSession,
    completeCheckpointSession,
    abortCheckpointSession
} from './checkpoint.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('CheckpointGate', () => {
    let testDir: string;

    beforeEach(() => {
        testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'checkpoint-test-'));
    });

    afterEach(() => {
        clearCheckpointSession(testDir);
        fs.rmSync(testDir, { recursive: true, force: true });
    });

    describe('gate initialization', () => {
        it('should create gate with default config', () => {
            const gate = new CheckpointGate();
            expect(gate.id).toBe('checkpoint');
            expect(gate.title).toBe('Checkpoint Supervision');
        });

        it('should skip when not enabled', async () => {
            const gate = new CheckpointGate({ enabled: false });
            const failures = await gate.run({ cwd: testDir });
            expect(failures).toEqual([]);
        });
    });

    describe('session management', () => {
        it('should create a new session', () => {
            const session = getOrCreateCheckpointSession(testDir);
            expect(session.sessionId).toMatch(/^chk-session-/);
            expect(session.status).toBe('active');
            expect(session.checkpoints).toHaveLength(0);
        });

        it('should record a checkpoint', () => {
            const result = recordCheckpoint(
                testDir,
                25, // progressPct
                ['src/api/users.ts'],
                'Implemented user API',
                85 // qualityScore
            );

            expect(result.continue).toBe(true);
            expect(result.checkpoint.progressPct).toBe(25);
            expect(result.checkpoint.qualityScore).toBe(85);
        });

        it('should persist session to disk', () => {
            recordCheckpoint(testDir, 50, [], 'Test', 90);
            const sessionPath = path.join(testDir, '.rigour', 'checkpoint-session.json');
            expect(fs.existsSync(sessionPath)).toBe(true);
        });

        it('should complete session', () => {
            getOrCreateCheckpointSession(testDir);
            completeCheckpointSession(testDir);
            const session = getCheckpointSession(testDir);
            expect(session?.status).toBe('completed');
        });

        it('should abort session with reason', () => {
            getOrCreateCheckpointSession(testDir);
            abortCheckpointSession(testDir, 'Quality too low');
            const session = getCheckpointSession(testDir);
            expect(session?.status).toBe('aborted');
            expect(session?.checkpoints[0].summary).toContain('Quality too low');
        });
    });

    describe('quality threshold', () => {
        it('should continue when quality above threshold', () => {
            const result = recordCheckpoint(testDir, 50, [], 'Good work', 85);
            expect(result.continue).toBe(true);
            expect(result.warnings).toHaveLength(0);
        });

        it('should stop when quality below threshold', () => {
            const result = recordCheckpoint(testDir, 50, [], 'Poor work', 70);
            expect(result.continue).toBe(false);
            expect(result.warnings).toContain('Quality score 70% is below threshold 80%');
        });
    });

    describe('drift detection', () => {
        it('should detect quality degradation', () => {
            // Record several checkpoints with declining quality
            recordCheckpoint(testDir, 20, [], 'Start', 95);
            recordCheckpoint(testDir, 40, [], 'Middle', 90);
            const result = recordCheckpoint(testDir, 60, [], 'Decline', 75);

            expect(result.warnings.some(w => w.includes('Drift detected'))).toBe(true);
        });

        it('should not flag stable quality', () => {
            recordCheckpoint(testDir, 20, [], 'Start', 85);
            recordCheckpoint(testDir, 40, [], 'Middle', 85);
            const result = recordCheckpoint(testDir, 60, [], 'Stable', 85);

            expect(result.warnings.filter(w => w.includes('Drift'))).toHaveLength(0);
        });
    });

    describe('gate run', () => {
        it('should pass with healthy checkpoints', async () => {
            const gate = new CheckpointGate({ enabled: true, quality_threshold: 80 });
            recordCheckpoint(testDir, 50, [], 'Good work', 90);

            const failures = await gate.run({ cwd: testDir });
            expect(failures).toHaveLength(0);
        });

        it('should fail when quality below threshold', async () => {
            const gate = new CheckpointGate({ enabled: true, quality_threshold: 80 });
            recordCheckpoint(testDir, 50, [], 'Poor work', 70);

            const failures = await gate.run({ cwd: testDir });
            expect(failures.some(f => f.title === 'Quality Below Threshold')).toBe(true);
        });
    });
});
