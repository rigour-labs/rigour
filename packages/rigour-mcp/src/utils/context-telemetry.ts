/**
 * MCP tool telemetry metadata — honest token accounting from handlers.
 */
import fs from 'fs-extra';
import path from 'path';
import { estimateTokenCount } from '@rigour-labs/core';

export type CacheStatus = 'exact-hit' | 'semantic-hit' | 'partial-hit' | 'miss' | 'none';

export type TelemetryMeta = {
    candidateTokens: number;
    returnedTokens: number;
    cacheStatus: CacheStatus;
    deduplicatedTokens?: number;
    isEstimated?: boolean;
};

export type ToolResult = {
    content: { type: string; text: string }[];
    isError?: boolean;
    _shouldContinue?: boolean;
    _rigour_report?: unknown;
    _meta?: unknown;
    _telemetry?: TelemetryMeta;
};

export function buildTelemetryMeta(opts: {
    candidateText: string;
    returnedText: string;
    cacheStatus: CacheStatus;
    deduplicatedTokens?: number;
}): TelemetryMeta {
    return {
        candidateTokens: estimateTokenCount(opts.candidateText),
        returnedTokens: estimateTokenCount(opts.returnedText),
        cacheStatus: opts.cacheStatus,
        deduplicatedTokens: opts.deduplicatedTokens ?? 0,
        isEstimated: true,
    };
}

/** Resolve a short commit/ref fingerprint for cache keys. */
export async function getWorkspaceCommitSha(cwd: string): Promise<string> {
    try {
        const headPath = path.join(cwd, '.git', 'HEAD');
        if (!await fs.pathExists(headPath)) return 'workspace';

        const head = (await fs.readFile(headPath, 'utf-8')).trim();
        if (head.startsWith('ref:')) {
            const refPath = path.join(cwd, '.git', head.slice(5).trim());
            if (await fs.pathExists(refPath)) {
                return (await fs.readFile(refPath, 'utf-8')).trim().slice(0, 12);
            }
        }
        return head.slice(0, 12);
    } catch {
        return 'workspace';
    }
}
