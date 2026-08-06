/**
 * Cursor Admin API client for filtered usage events.
 */
import { getCursorApiKey } from '../settings.js';
import {
    normalizeCursorUsageEvent,
    parseCursorUsageApiResponse,
    type NormalizedCursorUsageEvent,
} from './cursor-usage-normalizer.js';

export const CURSOR_FILTERED_USAGE_URL = 'https://api.cursor.com/teams/filtered-usage-events';
export const DEFAULT_CURSOR_SYNC_DAYS = 30;
export const DEFAULT_CURSOR_PAGE_SIZE = 100;
export const MAX_CURSOR_SYNC_PAGES = 50;

export interface CursorUsageSyncOptions {
    cwd?: string;
    apiKey?: string;
    startDate?: number;
    endDate?: number;
    pageSize?: number;
    maxPages?: number;
    fetchImpl?: typeof fetch;
}

export class CursorUsageApiError extends Error {
    readonly status: number;

    constructor(status: number, message: string) {
        super(message);
        this.name = 'CursorUsageApiError';
        this.status = status;
    }
}

function buildBasicAuthHeader(apiKey: string): string {
    const token = Buffer.from(`${apiKey}:`, 'utf8').toString('base64');
    return `Basic ${token}`;
}

function defaultDateRange(): { startDate: number; endDate: number } {
    const endDate = Date.now();
    const startDate = endDate - DEFAULT_CURSOR_SYNC_DAYS * 24 * 60 * 60 * 1000;
    return { startDate, endDate };
}

export async function fetchCursorUsagePages(
    options: CursorUsageSyncOptions = {},
): Promise<NormalizedCursorUsageEvent[]> {
    const apiKey = options.apiKey ?? getCursorApiKey();
    if (!apiKey) {
        return [];
    }

    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    if (!fetchImpl) {
        throw new CursorUsageApiError(0, 'Fetch is not available in this environment');
    }

    const range = defaultDateRange();
    const startDate = options.startDate ?? range.startDate;
    const endDate = options.endDate ?? range.endDate;
    const pageSize = options.pageSize ?? DEFAULT_CURSOR_PAGE_SIZE;
    const maxPages = options.maxPages ?? MAX_CURSOR_SYNC_PAGES;

    const events: NormalizedCursorUsageEvent[] = [];
    let page = 1;
    let hasNextPage = true;

    while (hasNextPage && page <= maxPages) {
        const response = await fetchImpl(CURSOR_FILTERED_USAGE_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: buildBasicAuthHeader(apiKey),
            },
            body: JSON.stringify({ startDate, endDate, page, pageSize }),
        });

        if (!response.ok) {
            const detail = await response.text().catch(() => '');
            const safeDetail = detail.replace(apiKey, '[REDACTED]').slice(0, 200);
            throw new CursorUsageApiError(
                response.status,
                `Cursor Admin API request failed (${response.status}). ${safeDetail || 'Check API key scope and date range.'}`,
            );
        }

        const json: unknown = await response.json();
        const parsed = parseCursorUsageApiResponse(json);

        for (const rawEvent of parsed.usageEvents ?? []) {
            const normalized = normalizeCursorUsageEvent(rawEvent);
            if (normalized) {
                events.push(normalized);
            }
        }

        hasNextPage = Boolean(parsed.pagination?.hasNextPage);
        page += 1;
    }

    if (hasNextPage) {
        throw new CursorUsageApiError(
            413,
            `Cursor usage sync truncated after ${maxPages} pages. Narrow the date range or contact support.`,
        );
    }

    return events;
}
