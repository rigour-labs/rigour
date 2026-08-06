import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs-extra';

vi.mock('./db.js', () => ({
    isSQLiteAvailable: () => false,
    openDatabase: async () => null,
    DB_PATH: '/tmp/rigour-test.db',
    RIGOUR_DIR: '/tmp/.rigour',
}));

import {
    recordContextEvent,
    recordModelUsage,
    setContextCacheRecord,
    getContextCacheRecord,
    recordCheckpointMetric,
    getContextEvents,
    getModelUsages,
    getCheckpointMetrics,
} from './context-telemetry.js';

describe('context-telemetry storage', () => {
    const testCwd = path.join(os.tmpdir(), `rigour-ctx-telemetry-${Date.now()}`);

    beforeEach(async () => {
        await fs.ensureDir(path.join(testCwd, '.rigour'));
    });

    afterEach(async () => {
        await fs.remove(testCwd);
    });

    it('records and retrieves context events via JSON fallback', async () => {
        const id = await recordContextEvent({
            taskId: 'task-1',
            toolName: 'rigour_recall',
            cacheStatus: 'semantic-hit',
            candidateTokens: 4000,
            returnedTokens: 800,
            deduplicatedTokens: 1200,
        }, testCwd);

        expect(id).toMatch(/^evt-/);

        const events = await getContextEvents('task-1', testCwd);
        expect(events).toHaveLength(1);
        expect(events[0].toolName).toBe('rigour_recall');
        expect(events[0].candidateTokens).toBe(4000);
        expect(events[0].returnedTokens).toBe(800);
    });

    it('records and retrieves model usage via JSON fallback', async () => {
        await recordModelUsage({
            taskId: 'cursor-imported',
            provider: 'cursor',
            model: 'claude-3-5-sonnet',
            inputTokens: 12000,
            outputTokens: 1500,
            observedCostUsd: 1.25,
            source: 'cursor-dashboard-csv',
        }, testCwd);

        const usages = await getModelUsages(undefined, testCwd);
        expect(usages).toHaveLength(1);
        expect(usages[0].inputTokens).toBe(12000);
        expect(usages[0].source).toBe('cursor-dashboard-csv');
    });

    it('stores cache records and increments hit count', async () => {
        await setContextCacheRecord({
            cacheKey: 'static:repo:main:file.ts:abc123:v1',
            cacheType: 'static',
            repo: 'repo',
            branch: 'main',
            dependencyFingerprint: 'dep-1',
            payloadJson: JSON.stringify({ exports: ['foo'] }),
            payloadTokens: 42,
        }, testCwd);

        const first = await getContextCacheRecord('static:repo:main:file.ts:abc123:v1', testCwd);
        const second = await getContextCacheRecord('static:repo:main:file.ts:abc123:v1', testCwd);

        expect(first?.payloadTokens).toBe(42);
        expect(second?.hitCount).toBe(2);
    });

    it('records and retrieves checkpoint metrics via JSON fallback', async () => {
        await recordCheckpointMetric({
            checkpointId: 'checkpoint:CTP-1:agent-a:implementation',
            taskId: 'CTP-1',
            agentId: 'agent-a',
            rawStateTokens: 50000,
            checkpointTokens: 400,
            replayTokensAvoided: 49600,
        }, testCwd);

        const metrics = await getCheckpointMetrics('CTP-1', testCwd);
        expect(metrics).toHaveLength(1);
        expect(metrics[0].rawStateTokens).toBe(50000);
        expect(metrics[0].replayTokensAvoided).toBe(49600);
    });
});
