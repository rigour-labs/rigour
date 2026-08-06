import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs-extra';

vi.mock('../storage/db.js', () => ({
    isSQLiteAvailable: () => false,
    openDatabase: async () => null,
    DB_PATH: '/tmp/rigour-test.db',
    RIGOUR_DIR: '/tmp/.rigour',
}));

import {
    getTaskContextStats,
    getTaskCostStats,
    getCacheStats,
    importCursorUsageCsv,
    importCursorUsageJson,
    getContextScopeSummary,
    getCheckpointSummary,
    estimateTokenCount,
} from './context-telemetry-service.js';
import { recordContextEvent, recordCheckpointMetric } from '../storage/context-telemetry.js';

describe('context-telemetry-service', () => {
    const testCwd = path.join(os.tmpdir(), `rigour-ctx-service-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const taskId = `task-${Date.now()}`;

    beforeEach(async () => {
        await fs.ensureDir(path.join(testCwd, '.rigour'));
    });

    afterEach(async () => {
        await fs.remove(testCwd);
    });

    it('returns zeroed stats when no telemetry exists for task', async () => {
        const stats = await getTaskContextStats(taskId, testCwd);
        expect(stats.retrievals).toBe(0);
        expect(stats.candidateTokens).toBe(0);
        expect(stats.potentialAvoidedTokens).toBe(0);
        expect(stats.isEstimated).toBe(true);
    });

    it('calculates avoided context from recorded events', async () => {
        await recordContextEvent({
            taskId,
            toolName: 'rigour_check_pattern',
            cacheStatus: 'exact-hit',
            candidateTokens: 10000,
            returnedTokens: 2000,
            deduplicatedTokens: 3000,
        }, testCwd);

        const stats = await getTaskContextStats(taskId, testCwd);
        expect(stats.retrievals).toBe(1);
        expect(stats.potentialAvoidedTokens).toBe(8000);
        expect(stats.repeatedReadsPrevented).toBeGreaterThan(0);
        expect(stats.isEstimated).toBe(false);
    });

    it('aggregates cache performance from events', async () => {
        const cacheTaskId = `${taskId}-cache`;
        await recordContextEvent({
            taskId: cacheTaskId,
            toolName: 'rigour_recall',
            cacheStatus: 'exact-hit',
            candidateTokens: 1000,
            returnedTokens: 200,
        }, testCwd);
        await recordContextEvent({
            taskId: cacheTaskId,
            toolName: 'rigour_context_explain',
            cacheStatus: 'miss',
            candidateTokens: 500,
            returnedTokens: 500,
        }, testCwd);

        const events = await import('../storage/context-telemetry.js').then(m => m.getContextEvents(cacheTaskId, testCwd));
        const cache = await getCacheStats(testCwd);
        const taskHits = events.filter(e => e.cacheStatus === 'exact-hit').length;
        const taskMisses = events.filter(e => e.cacheStatus === 'miss').length;
        expect(taskHits).toBe(1);
        expect(taskMisses).toBe(1);
        expect(cache.hitRate).toBe(0.5);
        expect(cache.isEstimated).toBe(false);
    });

    it('imports CSV usage and marks cost stats as observed', async () => {
        const csv = `Date,Model,Input Tokens,Output Tokens,Cost
2026-08-05,claude-3-5-sonnet,510000,62000,4.83`;

        const imported = await importCursorUsageCsv(csv, testCwd);
        expect(imported).toBe(1);

        const cost = await getTaskCostStats('cursor-imported', testCwd);
        expect(cost.actual.inputTokens).toBe(510000);
        expect(cost.actual.costUsd).toBe(4.83);
        expect(cost.actual.isEstimated).toBe(false);
    });

    it('deduplicates CSV rows on re-import', async () => {
        const csv = `Date,Model,Input Tokens,Output Tokens,Cost
2026-08-05,claude-3-5-sonnet,1000,100,1.00`;

        expect(await importCursorUsageCsv(csv, testCwd)).toBe(1);
        expect(await importCursorUsageCsv(csv, testCwd)).toBe(0);
    });

    it('imports JSON usage records', async () => {
        const jsonTaskId = `${taskId}-json-${Math.random().toString(36).slice(2)}`;
        const imported = await importCursorUsageJson([{
            taskId: jsonTaskId,
            inputTokens: 2500,
            outputTokens: 300,
            observedCostUsd: 0.42,
            model: 'gpt-4o',
        }], testCwd);

        expect(imported).toBe(1);
        const cost = await getTaskCostStats(jsonTaskId, testCwd);
        expect(cost.actual.inputTokens).toBe(2500);
    });

    it('imports Admin API JSON events with chargedCents and dedupes against sync IDs', async () => {
        const adminEvent = {
            timestamp: '1750979225854',
            conversationId: 'conv-dedupe',
            model: 'composer-2.5-standard',
            chargedCents: 42.5,
            tokenUsage: { inputTokens: 100, outputTokens: 50 },
        };

        expect(await importCursorUsageJson([adminEvent], testCwd)).toBe(1);
        expect(await importCursorUsageJson([adminEvent], testCwd)).toBe(0);

        const cost = await getTaskCostStats('conv-dedupe', testCwd);
        expect(cost.actual.costUsd).toBeCloseTo(0.425, 3);
        expect(cost.actual.isEstimated).toBe(false);
    });

    it('summarizes agent scope overlap from session file', async () => {
        await fs.writeJson(path.join(testCwd, '.rigour', 'agent-session.json'), {
            agents: [
                { agentId: 'agent-a', taskScope: ['src/api/**'] },
                { agentId: 'agent-b', taskScope: ['src/api/**', 'tests/**'] },
            ],
        });

        const scope = await getContextScopeSummary(testCwd);
        expect(scope.activeAgentCount).toBe(2);
        expect(scope.overlappingScopesResolved).toBeGreaterThan(0);
    });

    it('estimates governance rule token overhead from AGENTS.md', async () => {
        await fs.writeFile(path.join(testCwd, 'AGENTS.md'), '# Agent rules\n'.repeat(40));

        const scope = await getContextScopeSummary(testCwd);
        expect(scope.alwaysOnRuleTokens).toBe(estimateTokenCount('# Agent rules\n'.repeat(40)));
    });

    it('aggregates checkpoint compression metrics', async () => {
        const cpTaskId = `${taskId}-cp`;
        await recordCheckpointMetric({
            checkpointId: `checkpoint:${cpTaskId}:a1:phase`,
            taskId: cpTaskId,
            agentId: 'a1',
            rawStateTokens: 10000,
            checkpointTokens: 500,
            replayTokensAvoided: 9500,
        }, testCwd);

        const summary = await getCheckpointSummary(cpTaskId, testCwd);
        expect(summary.checkpointCount).toBe(1);
        expect(summary.rawStateTokens).toBe(10000);
        expect(summary.compressionRatio).toBe(20);
        expect(summary.replayTokensAvoided).toBe(9500);
    });

    it('marks observed cost from usages and estimates avoided cost by model', async () => {
        const jsonTaskId = `${taskId}-composer-${Math.random().toString(36).slice(2)}`;
        await importCursorUsageJson([{
            id: `json-composer-${jsonTaskId}`,
            taskId: jsonTaskId,
            inputTokens: 2_000_000,
            outputTokens: 0,
            observedCostUsd: 1.25,
            model: 'composer-2.5-standard',
            source: 'cursor-admin-api',
        }], testCwd);

        await recordContextEvent({
            taskId: jsonTaskId,
            toolName: 'rigour_context_scope',
            cacheStatus: 'miss',
            candidateTokens: 3_000_000,
            returnedTokens: 1_000_000,
        }, testCwd);

        const cost = await getTaskCostStats(jsonTaskId, testCwd);
        expect(cost.actual.isEstimated).toBe(false);
        expect(cost.actual.costUsd).toBe(1.25);
        expect(cost.estimated.isEstimated).toBe(true);
        expect(cost.estimated.inputPricePerMillionUsd).toBe(0.5);
        expect(cost.estimated.estimatedCostAvoidedUsd).toBeGreaterThan(0);
    });
});
