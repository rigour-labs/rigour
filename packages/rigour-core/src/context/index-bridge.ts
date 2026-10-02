/**
 * Health of the pattern index (.rigour/patterns.json): present, readable, fresh.
 */

import fs from 'fs-extra';
import path from 'path';
import type { PatternIndex } from '../pattern-index/types.js';

function getIndexPath(cwd: string): string {
    return path.join(cwd, '.rigour', 'patterns.json');
}

export interface IndexHealthReport {
    indexPath: string;
    exists: boolean;
    lastUpdated?: string;
    ageMs?: number;
    isStale: boolean;
    staleThresholdMs: number;
    totalPatterns?: number;
    totalFiles?: number;
    message: string;
}

const DEFAULT_STALE_MS = 24 * 60 * 60 * 1000;

/**
 * Check patterns.json freshness relative to the project directory.
 */
export async function getIndexHealth(cwd: string, staleThresholdMs = DEFAULT_STALE_MS): Promise<IndexHealthReport> {
    const resolved = path.resolve(cwd);
    const indexPath = getIndexPath(resolved);

    if (!await fs.pathExists(indexPath)) {
        return {
            indexPath,
            exists: false,
            isStale: true,
            staleThresholdMs,
            message: 'patterns.json not found — run pattern index build',
        };
    }

    const stat = await fs.stat(indexPath);
    const ageMs = Date.now() - stat.mtimeMs;
    let index: PatternIndex | null = null;

    try {
        index = await fs.readJson(indexPath) as PatternIndex;
    } catch {
        return {
            indexPath,
            exists: true,
            ageMs,
            isStale: true,
            staleThresholdMs,
            message: 'patterns.json is malformed',
        };
    }

    const isStale = ageMs > staleThresholdMs;
    return {
        indexPath,
        exists: true,
        lastUpdated: index.lastUpdated,
        ageMs,
        isStale,
        staleThresholdMs,
        totalPatterns: index.stats?.totalPatterns,
        totalFiles: index.stats?.totalFiles,
        message: isStale
            ? `Index is stale (${Math.round(ageMs / 3600000)}h old)`
            : 'Index is fresh',
    };
}
