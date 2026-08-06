import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs-extra';
import { recordContextEvent, getContextEvents } from '@rigour-labs/core';
import {
    handleContextStats,
    handleTaskCost,
    handleCacheStats,
    handleContextExplain,
} from './context-handlers.js';

describe('context MCP handlers', () => {
    const testCwd = path.join(os.tmpdir(), `rigour-ctx-handlers-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const taskId = `task-${Date.now()}`;

    beforeEach(async () => {
        await fs.ensureDir(path.join(testCwd, '.rigour'));
    });

    afterEach(async () => {
        await fs.remove(testCwd);
    });

    it('handleContextStats returns valid JSON shape', async () => {
        await recordContextEvent({
            taskId,
            toolName: 'rigour_recall',
            cacheStatus: 'semantic-hit',
            candidateTokens: 3000,
            returnedTokens: 600,
        }, testCwd);

        const result = await handleContextStats(testCwd, taskId);
        expect(result.isError).toBeUndefined();

        const stats = JSON.parse(result.content[0].text);
        expect(stats.retrievals).toBe(1);
        expect(stats.candidateTokens).toBe(3000);
        expect(typeof stats.potentialAvoidedTokens).toBe('number');
    });

    it('handleTaskCost returns actual and estimated sections', async () => {
        const result = await handleTaskCost(testCwd);
        const cost = JSON.parse(result.content[0].text);

        expect(cost.actual).toBeDefined();
        expect(cost.estimated).toBeDefined();
        expect(typeof cost.actual.costUsd).toBe('number');
        expect(typeof cost.estimated.estimatedCostAvoidedUsd).toBe('number');
    });

    it('handleCacheStats returns cache counters', async () => {
        const cacheTaskId = `${taskId}-cache`;
        await recordContextEvent({
            taskId: cacheTaskId,
            toolName: 'rigour_check_pattern',
            cacheStatus: 'exact-hit',
            candidateTokens: 1000,
            returnedTokens: 250,
        }, testCwd);

        const events = await getContextEvents(cacheTaskId, testCwd);
        const result = await handleCacheStats(testCwd);
        const cache = JSON.parse(result.content[0].text);

        expect(events.filter(e => e.cacheStatus === 'exact-hit').length).toBe(1);
        expect(cache.exactCacheHits).toBeGreaterThanOrEqual(1);
        expect(typeof cache.hitRate).toBe('number');
    });

    it('handleContextExplain returns exclusion when no matching events', async () => {
        const result = await handleContextExplain(testCwd, 'services/missing');
        const explanation = JSON.parse(result.content[0].text);

        expect(explanation.status).toBe('excluded');
        expect(explanation.fileOrService).toBe('services/missing');
        expect(Array.isArray(explanation.priorAgentRequests)).toBe(true);
    });

    it('handleContextExplain returns inclusion for matching tool events', async () => {
        const uniqueTarget = `services/task-${Date.now()}`;
        await recordContextEvent({
            taskId,
            toolName: uniqueTarget,
            cacheStatus: 'exact-hit',
            candidateTokens: 2000,
            returnedTokens: 400,
            returnedFiles: 1,
        }, testCwd);

        const result = await handleContextExplain(testCwd, uniqueTarget, taskId);
        const explanation = JSON.parse(result.content[0].text);

        expect(explanation.status).toBe('included');
        expect(explanation.servedFromCache).toBe(true);
    });
});
