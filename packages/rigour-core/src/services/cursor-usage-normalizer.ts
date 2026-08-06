/**
 * Parse and normalize Cursor Admin API filtered usage events.
 */
import { createHash } from 'crypto';
import type { ModelUsage } from '../storage/context-telemetry.js';

export const CURSOR_ADMIN_API_SOURCE = 'cursor-admin-api';

export interface NormalizedCursorUsageEvent {
    id: string;
    usage: ModelUsage;
}

export interface CursorUsageApiResponse {
    totalUsageEventsCount?: number;
    usageEvents?: unknown[];
    pagination?: {
        hasNextPage?: boolean;
        currentPage?: number;
        numPages?: number;
        pageSize?: number;
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isCursorAdminApiEvent(value: unknown): value is Record<string, unknown> {
    if (!isRecord(value)) return false;
    return value.tokenUsage !== undefined
        || value.chargedCents !== undefined
        || (value.timestamp !== undefined && value.model !== undefined);
}

function readNumber(value: unknown, fallback = 0): number {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '') {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) return parsed;
    }
    return fallback;
}

function readString(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Cursor reports costs in cents (`chargedCents`, `tokenUsage.totalCents`).
 */
export function centsToUsd(cents: number): number {
    return parseFloat((cents / 100).toFixed(6));
}

export function buildCursorEventFingerprint(event: Record<string, unknown>): string {
    const tokenUsage = isRecord(event.tokenUsage) ? event.tokenUsage : {};
    const payload = [
        readString(event.timestamp) ?? '',
        readString(event.userEmail) ?? '',
        readString(event.conversationId) ?? '',
        readString(event.model) ?? '',
        readNumber(event.chargedCents),
        readNumber(tokenUsage.inputTokens),
        readNumber(tokenUsage.outputTokens),
        readNumber(tokenUsage.cacheReadTokens),
        readNumber(tokenUsage.cacheWriteTokens),
    ].join('|');

    return createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

export function normalizeCursorUsageEvent(raw: unknown): NormalizedCursorUsageEvent | null {
    if (!isRecord(raw)) return null;

    const model = readString(raw.model) ?? 'unknown-model';
    const timestamp = readString(raw.timestamp);
    const conversationId = readString(raw.conversationId);
    const tokenUsage = isRecord(raw.tokenUsage) ? raw.tokenUsage : undefined;

    const inputTokens = tokenUsage ? readNumber(tokenUsage.inputTokens) : 0;
    const outputTokens = tokenUsage ? readNumber(tokenUsage.outputTokens) : 0;
    const cacheReadTokens = tokenUsage ? readNumber(tokenUsage.cacheReadTokens) : 0;
    const cacheWriteTokens = tokenUsage ? readNumber(tokenUsage.cacheWriteTokens) : 0;

    const chargedCents = readNumber(raw.chargedCents);
    const tokenTotalCents = tokenUsage ? readNumber(tokenUsage.totalCents) : 0;
    const observedCostUsd = chargedCents > 0
        ? centsToUsd(chargedCents)
        : tokenTotalCents > 0
            ? centsToUsd(tokenTotalCents)
            : 0;

    const fingerprint = buildCursorEventFingerprint(raw);
    const createdAt = timestamp ? readNumber(timestamp, Date.now()) : Date.now();

    return {
        id: `cursor-api-${fingerprint}`,
        usage: {
            id: `cursor-api-${fingerprint}`,
            taskId: conversationId ?? 'cursor-imported',
            sessionId: conversationId,
            provider: 'cursor',
            model,
            inputTokens,
            outputTokens,
            cachedInputTokens: cacheReadTokens,
            cacheWriteTokens,
            observedCostUsd,
            source: CURSOR_ADMIN_API_SOURCE,
            createdAt,
        },
    };
}

export function parseCursorUsageApiResponse(body: unknown): CursorUsageApiResponse {
    if (!isRecord(body)) {
        return {};
    }
    return {
        totalUsageEventsCount: readNumber(body.totalUsageEventsCount),
        usageEvents: Array.isArray(body.usageEvents) ? body.usageEvents : [],
        pagination: isRecord(body.pagination) ? {
            hasNextPage: Boolean(body.pagination.hasNextPage),
            currentPage: readNumber(body.pagination.currentPage, 1),
            numPages: readNumber(body.pagination.numPages, 1),
            pageSize: readNumber(body.pagination.pageSize, 0),
        } : undefined,
    };
}
