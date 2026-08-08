import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs-extra';
import { recordContextEvent, getContextEvents, setSemanticQueryCache } from '@rigour-labs/core';
import {
    handleContextStats,
    handleTaskCost,
    handleCacheStats,
    handleContextExplain,
    handleContextScope,
} from './context-handlers.js';
import { getWorkspaceCommitSha } from '../utils/context-telemetry.js';

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

    it('handleContextScope works without task and agent IDs', async () => {
        const result = await handleContextScope(testCwd, 'task service priority field', 5);
        expect(result.isError).toBeUndefined();
        expect(result._telemetry?.queryHash).toBeDefined();
        expect(result._telemetry?.taskId).toBeUndefined();
    });

    it('handleContextScope attaches task and agent attribution for telemetry', async () => {
        const scopeTaskId = `${taskId}-scope`;
        const agentId = 'agent-scope-1';
        const result = await handleContextScope(
            testCwd,
            'authentication middleware',
            5,
            scopeTaskId,
            agentId,
        );

        expect(result._telemetry?.taskId).toBe(scopeTaskId);
        expect(result._telemetry?.agentId).toBe(agentId);
        expect(result._telemetry?.queryHash).toHaveLength(16);
    });

    it('records scoped context events filterable by taskId', async () => {
        const scopeTaskId = `${taskId}-filter`;
        const agentId = 'agent-filter';
        const result = await handleContextScope(
            testCwd,
            'cache layer telemetry',
            5,
            scopeTaskId,
            agentId,
        );

        await recordContextEvent({
            taskId: result._telemetry?.taskId,
            agentId: result._telemetry?.agentId,
            toolName: 'rigour_context_scope',
            queryHash: result._telemetry?.queryHash,
            cacheStatus: result._telemetry?.cacheStatus ?? 'miss',
            candidateTokens: result._telemetry?.candidateTokens ?? 0,
            returnedTokens: result._telemetry?.returnedTokens ?? 0,
            deduplicatedTokens: result._telemetry?.deduplicatedTokens ?? 0,
        }, testCwd);

        const stats = await handleContextStats(testCwd, scopeTaskId);
        const parsed = JSON.parse(stats.content[0].text);
        expect(parsed.retrievals).toBe(1);
        expect(parsed.taskId).toBe(scopeTaskId);
    });

    it('attributes exact cache hits to task and agent', async () => {
        const scopeTaskId = `${taskId}-cache-hit`;
        const agentId = 'agent-cache';
        const query = `unique-query-${Date.now()}`;
        const commitSha = await getWorkspaceCommitSha(testCwd);

        await fs.ensureDir(path.join(testCwd, 'src'));
        await fs.writeFile(path.join(testCwd, 'src/example.ts'), 'export const example = 1;\n');

        await setSemanticQueryCache(query, commitSha, {
            query,
            resolvedOwner: 'src',
            editScope: ['src/example.ts'],
            validationScope: ['review src/example.ts'],
            evidence: ['cached scope'],
            commitSha,
            confidence: 0.9,
        }, testCwd);

        const result = await handleContextScope(testCwd, query, 5, scopeTaskId, agentId);

        expect(result._telemetry?.cacheStatus).toBe('exact-hit');
        expect(result._telemetry?.taskId).toBe(scopeTaskId);
        expect(result._telemetry?.agentId).toBe(agentId);
        expect(result._telemetry?.queryHash).toHaveLength(16);
    });

    it('serves partial-hit for highly related query at same commit', async () => {
        const commitSha = await getWorkspaceCommitSha(testCwd);
        await fs.ensureDir(path.join(testCwd, 'src'));
        await fs.writeFile(path.join(testCwd, 'src/example.ts'), 'export const example = 1;\n');

        await setSemanticQueryCache('task priority persistence', commitSha, {
            query: 'task priority persistence',
            resolvedOwner: 'src',
            editScope: ['src/example.ts'],
            validationScope: ['review src/example.ts'],
            evidence: ['related scope'],
            commitSha,
            confidence: 0.9,
        }, testCwd);

        const result = await handleContextScope(
            testCwd,
            'priority for task persistence layer',
            5,
            `${taskId}-partial`,
            'agent-partial',
        );
        expect(result._telemetry?.cacheStatus).toBe('partial-hit');
        expect(result.content[0].text).toContain('partial cache');
    });
});
