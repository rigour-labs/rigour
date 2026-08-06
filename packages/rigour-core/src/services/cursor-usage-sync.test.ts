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
    fetchCursorUsageFromAdminApi,
    syncCursorUsageFromAdminApi,
    getTaskCostStats,
} from './context-telemetry-service.js';
import { getModelUsages } from '../storage/context-telemetry.js';
import { centsToUsd, normalizeCursorUsageEvent } from './cursor-usage-normalizer.js';
import { CURSOR_FILTERED_USAGE_URL } from './cursor-usage-client.js';

function buildUsageEvent(overrides: Record<string, unknown> = {}) {
    return {
        timestamp: '1750979225854',
        userEmail: 'dev@example.com',
        conversationId: 'conv-1',
        model: 'composer-2.5-standard',
        isTokenBasedCall: true,
        tokenUsage: {
            inputTokens: 100,
            outputTokens: 50,
            cacheWriteTokens: 10,
            cacheReadTokens: 20,
            totalCents: 12.5,
        },
        chargedCents: 15.25,
        ...overrides,
    };
}

describe('cursor admin usage sync', () => {
    const testCwd = path.join(os.tmpdir(), `rigour-cursor-sync-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const apiKey = 'test-cursor-admin-key';

    beforeEach(async () => {
        await fs.ensureDir(path.join(testCwd, '.rigour'));
    });

    afterEach(async () => {
        await fs.remove(testCwd);
        vi.restoreAllMocks();
    });

    it('imports a single-page response with basic auth header', async () => {
        const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => ({
            ok: true,
            status: 200,
            json: async () => ({
                usageEvents: [buildUsageEvent()],
                pagination: { hasNextPage: false, currentPage: 1 },
            }),
        })) as unknown as typeof fetch;

        const imported = await fetchCursorUsageFromAdminApi({
            cwd: testCwd,
            apiKey,
            fetchImpl,
        });

        expect(imported).toBe(1);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        const [, init] = (fetchImpl as any).mock.calls[0];
        expect(init.method).toBe('POST');
        expect(init.headers.Authorization).toBe(
            `Basic ${Buffer.from(`${apiKey}:`, 'utf8').toString('base64')}`,
        );
        expect(init.headers['Content-Type']).toBe('application/json');
        const body = JSON.parse(init.body);
        expect(body.pageSize).toBeGreaterThan(0);
        expect(body.startDate).toBeLessThan(body.endDate);
    });

    it('paginates until hasNextPage is false', async () => {
        let page = 0;
        const fetchImpl = vi.fn(async () => {
            page += 1;
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    usageEvents: [buildUsageEvent({ conversationId: `conv-${page}` })],
                    pagination: { hasNextPage: page < 2, currentPage: page },
                }),
            };
        }) as unknown as typeof fetch;

        const result = await syncCursorUsageFromAdminApi({ cwd: testCwd, apiKey, fetchImpl });
        expect(result.importedCount).toBe(2);
        expect(result.totalEvents).toBe(2);
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it('converts cents to USD and stores token fields', async () => {
        const normalized = normalizeCursorUsageEvent(buildUsageEvent());
        expect(normalized?.usage.observedCostUsd).toBe(centsToUsd(15.25));
        expect(normalized?.usage.inputTokens).toBe(100);
        expect(normalized?.usage.outputTokens).toBe(50);
        expect(normalized?.usage.cachedInputTokens).toBe(20);
        expect(normalized?.usage.cacheWriteTokens).toBe(10);
        expect(normalized?.usage.source).toBe('cursor-admin-api');
    });

    it('deduplicates repeated syncs', async () => {
        const fetchImpl = vi.fn(async () => ({
            ok: true,
            status: 200,
            json: async () => ({
                usageEvents: [buildUsageEvent()],
                pagination: { hasNextPage: false },
            }),
        })) as unknown as typeof fetch;

        const first = await fetchCursorUsageFromAdminApi({ cwd: testCwd, apiKey, fetchImpl });
        const second = await fetchCursorUsageFromAdminApi({ cwd: testCwd, apiKey, fetchImpl });
        expect(first).toBe(1);
        expect(second).toBe(0);

        const usages = await getModelUsages(undefined, testCwd);
        expect(usages.filter(u => u.source === 'cursor-admin-api')).toHaveLength(1);
    });

    it('surfaces actionable non-2xx errors without exposing the API key', async () => {
        const fetchImpl = vi.fn(async () => ({
            ok: false,
            status: 401,
            text: async () => `Unauthorized for key ${apiKey}`,
        })) as unknown as typeof fetch;

        await expect(
            fetchCursorUsageFromAdminApi({ cwd: testCwd, apiKey, fetchImpl }),
        ).rejects.toThrow(/401/);

        await expect(
            fetchCursorUsageFromAdminApi({ cwd: testCwd, apiKey, fetchImpl }),
        ).rejects.not.toThrow(apiKey);
    });

    it('skips malformed events and handles partial fields', async () => {
        const fetchImpl = vi.fn(async () => ({
            ok: true,
            status: 200,
            json: async () => ({
                usageEvents: [
                    null,
                    { model: 'composer-2.5-fast', chargedCents: 5 },
                    buildUsageEvent(),
                ],
                pagination: { hasNextPage: false },
            }),
        })) as unknown as typeof fetch;

        const imported = await fetchCursorUsageFromAdminApi({ cwd: testCwd, apiKey, fetchImpl });
        expect(imported).toBe(2);
    });

    it('marks observed cost stats from imported admin API events', async () => {
        const fetchImpl = vi.fn(async () => ({
            ok: true,
            status: 200,
            json: async () => ({
                usageEvents: [buildUsageEvent({ conversationId: 'cost-task' })],
                pagination: { hasNextPage: false },
            }),
        })) as unknown as typeof fetch;

        await fetchCursorUsageFromAdminApi({ cwd: testCwd, apiKey, fetchImpl });
        const cost = await getTaskCostStats('cost-task', testCwd);
        expect(cost.actual.isEstimated).toBe(false);
        expect(cost.actual.costUsd).toBeGreaterThan(0);
        expect(cost.actual.pricingBasis).toBe('observed-cursor-charged-cents');
    });

    it('targets the filtered usage events endpoint', () => {
        expect(CURSOR_FILTERED_USAGE_URL).toBe('https://api.cursor.com/teams/filtered-usage-events');
    });

    it('errors when pagination exceeds the defensive page limit', async () => {
        let page = 0;
        const fetchImpl = vi.fn(async () => {
            page += 1;
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    usageEvents: [buildUsageEvent({ conversationId: `conv-page-${page}` })],
                    pagination: { hasNextPage: true, currentPage: page },
                }),
            };
        }) as unknown as typeof fetch;

        await expect(
            fetchCursorUsageFromAdminApi({
                cwd: testCwd,
                apiKey,
                fetchImpl,
                maxPages: 2,
            }),
        ).rejects.toThrow(/truncated after 2 pages/);
    });
});
