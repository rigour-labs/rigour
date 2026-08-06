import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs-extra';

vi.mock('@rigour-labs/core', async () => {
    const telemetry = await import('../../rigour-core/src/services/context-telemetry-service.js');
    const storage = await import('../../rigour-core/src/storage/context-telemetry.js');
    const cache = await import('../../rigour-core/src/context/cache-engine.js');
    const settings = await import('../../rigour-core/src/settings.js');
    return {
        ...telemetry,
        ...storage,
        ...cache,
        getCursorApiKey: settings.getCursorApiKey,
        updateCursorApiKey: settings.updateCursorApiKey,
    };
});

vi.mock('../../rigour-core/src/storage/db.js', () => ({
    isSQLiteAvailable: () => false,
    openDatabase: async () => null,
    DB_PATH: '/tmp/rigour-test.db',
    RIGOUR_DIR: '/tmp/.rigour',
}));

import { recordContextEvent } from '../../rigour-core/src/storage/context-telemetry.js';
import { setTaskCheckpointCache } from '../../rigour-core/src/context/cache-engine.js';
import {
    getTaskContextStats,
    getCacheStats,
    getCheckpointSummary,
} from '../../rigour-core/src/services/context-telemetry-service.js';
import {
    handleContextStats,
    handleContextExplain,
} from './tools/context-handlers.js';

describe('context agent loop integration', () => {
    const testCwd = path.join(os.tmpdir(), `rigour-agent-loop-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const loopTaskId = `CTP-${Date.now()}`;

    beforeEach(async () => {
        await fs.ensureDir(path.join(testCwd, '.rigour'));
    });

    afterEach(async () => {
        await fs.remove(testCwd);
    });

    it('simulates recall → scope explain → checkpoint with measurable savings', async () => {
        await recordContextEvent({
            taskId: loopTaskId,
            sessionId: 'session-1',
            agentId: `${loopTaskId}-task`,
            toolName: 'rigour_recall',
            cacheStatus: 'semantic-hit',
            candidateTokens: 8000,
            returnedTokens: 1200,
            deduplicatedTokens: 2400,
        }, testCwd);

        await recordContextEvent({
            taskId: loopTaskId,
            sessionId: 'session-1',
            agentId: `${loopTaskId}-task`,
            toolName: 'rigour_check_pattern',
            cacheStatus: 'exact-hit',
            candidateTokens: 5000,
            returnedTokens: 900,
        }, testCwd);

        const explainResult = await handleContextExplain(testCwd, 'rigour_check_pattern', loopTaskId);
        const explanation = JSON.parse(explainResult.content[0].text);
        expect(explanation.status).toBe('included');

        await setTaskCheckpointCache({
            taskId: loopTaskId,
            agentId: `${loopTaskId}-task`,
            phase: 'implementation',
            component: 'services/task',
            changedFiles: ['services/task.ts'],
            decisions: ['Added priority field'],
            validation: ['npm test passed'],
            remainingWork: [],
            risks: [],
        }, 50000, testCwd);

        const statsResult = await handleContextStats(testCwd, loopTaskId);
        const stats = JSON.parse(statsResult.content[0].text);
        expect(stats.retrievals).toBe(2);
        expect(stats.potentialAvoidedTokens).toBeGreaterThan(0);

        const events = await import('../../rigour-core/src/storage/context-telemetry.js')
            .then(m => m.getContextEvents(loopTaskId, testCwd));
        expect(events.filter(e => e.cacheStatus === 'exact-hit').length).toBe(1);
        expect(events.filter(e => e.cacheStatus === 'semantic-hit').length).toBe(1);

        const serviceStats = await getTaskContextStats(loopTaskId, testCwd);
        expect(serviceStats.checkpointReplayAvoided).toBeGreaterThan(0);

        const checkpointSummary = await getCheckpointSummary(loopTaskId, testCwd);
        expect(checkpointSummary.checkpointCount).toBe(1);
        expect(checkpointSummary.replayTokensAvoided).toBeGreaterThan(0);

        const aggregateCache = await getCacheStats(testCwd);
        expect(aggregateCache.tokensServedFromCache).toBeGreaterThanOrEqual(0);
    });
});
