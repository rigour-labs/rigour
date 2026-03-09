/**
 * IncrementalCache — Cross-run file change detection.
 *
 * Stores file metadata (mtime + size) in .rigour/scan-cache.json.
 * On subsequent runs, compares against current state to detect changes.
 * If zero files changed, the cached report can be reused instantly.
 *
 * This turns repeated scans from O(files × gates) → O(files) stat calls.
 * Demo moment: "Second scan finishes in 50ms because nothing changed."
 */

import fs from 'fs-extra';
import path from 'path';
import type { Report } from '../types/index.js';

interface FileEntry {
    mtimeMs: number;
    size: number;
}

interface ScanCache {
    version: 2;
    timestamp: string;
    configHash: string;
    files: Record<string, FileEntry>;
    report: Report;
}

export interface IncrementalResult {
    /** true = all files unchanged, report is valid */
    hit: boolean;
    /** Cached report (only if hit=true) */
    report?: Report;
    /** Files that changed since last scan (only if hit=false) */
    changedFiles?: string[];
    /** Total files checked */
    totalFiles: number;
    /** Time spent on cache check (ms) */
    checkMs: number;
}

/**
 * Simple string hash for config diffing (not cryptographic).
 */
function quickHash(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash |= 0; // Convert to 32-bit integer
    }
    return hash.toString(36);
}

export class IncrementalCache {
    private cachePath: string;

    constructor(private cwd: string) {
        this.cachePath = path.join(cwd, '.rigour', 'scan-cache.json');
    }

    /**
     * Check if files have changed since last scan.
     * Returns { hit: true, report } if nothing changed.
     * Returns { hit: false, changedFiles } otherwise.
     */
    async check(currentFiles: string[], configStr: string): Promise<IncrementalResult> {
        const start = Date.now();

        // Load previous cache
        let cache: ScanCache | null = null;
        try {
            if (await fs.pathExists(this.cachePath)) {
                cache = await fs.readJson(this.cachePath);
            }
        } catch {
            // Corrupted cache — treat as miss
            cache = null;
        }

        // No cache or version mismatch → full scan
        if (!cache || cache.version !== 2) {
            return { hit: false, totalFiles: currentFiles.length, checkMs: Date.now() - start };
        }

        // Config changed → full scan (gates may have changed)
        const currentConfigHash = quickHash(configStr);
        if (cache.configHash !== currentConfigHash) {
            return { hit: false, totalFiles: currentFiles.length, checkMs: Date.now() - start };
        }

        // Check for file changes: added, removed, or modified
        const previousFiles = new Set(Object.keys(cache.files));
        const currentSet = new Set(currentFiles);
        const changedFiles: string[] = [];

        // Stat all current files in parallel (batched for OS fd limits)
        const BATCH = 64;
        const statMap = new Map<string, FileEntry>();

        for (let i = 0; i < currentFiles.length; i += BATCH) {
            const batch = currentFiles.slice(i, i + BATCH);
            const results = await Promise.allSettled(
                batch.map(async (file) => {
                    const fullPath = path.join(this.cwd, file);
                    const stat = await fs.stat(fullPath);
                    return { file, mtimeMs: stat.mtimeMs, size: stat.size };
                })
            );
            for (const result of results) {
                if (result.status === 'fulfilled') {
                    statMap.set(result.value.file, {
                        mtimeMs: result.value.mtimeMs,
                        size: result.value.size,
                    });
                }
            }
        }

        // Detect changes
        for (const file of currentFiles) {
            const current = statMap.get(file);
            if (!current) continue; // couldn't stat — consider changed
            const prev = cache.files[file];

            if (!prev) {
                // New file
                changedFiles.push(file);
            } else if (current.mtimeMs !== prev.mtimeMs || current.size !== prev.size) {
                // Modified file
                changedFiles.push(file);
            }
        }

        // Check for removed files
        for (const prevFile of previousFiles) {
            if (!currentSet.has(prevFile)) {
                changedFiles.push(prevFile); // Removed file counts as "changed"
            }
        }

        const checkMs = Date.now() - start;

        if (changedFiles.length === 0) {
            // Cache hit! Reuse the report but update the timestamp in report
            const cachedReport = cache.report;
            cachedReport.stats.duration_ms = checkMs;
            (cachedReport.stats as any).cached = true;
            return { hit: true, report: cachedReport, totalFiles: currentFiles.length, checkMs };
        }

        return { hit: false, changedFiles, totalFiles: currentFiles.length, checkMs };
    }

    /**
     * Save current scan results for next incremental check.
     */
    async save(files: string[], configStr: string, report: Report): Promise<void> {
        // Stat all files for the cache
        const fileEntries: Record<string, FileEntry> = {};
        const BATCH = 64;

        for (let i = 0; i < files.length; i += BATCH) {
            const batch = files.slice(i, i + BATCH);
            const results = await Promise.allSettled(
                batch.map(async (file) => {
                    const fullPath = path.join(this.cwd, file);
                    const stat = await fs.stat(fullPath);
                    return { file, mtimeMs: stat.mtimeMs, size: stat.size };
                })
            );
            for (const result of results) {
                if (result.status === 'fulfilled') {
                    fileEntries[result.value.file] = {
                        mtimeMs: result.value.mtimeMs,
                        size: result.value.size,
                    };
                }
            }
        }

        const cache: ScanCache = {
            version: 2,
            timestamp: new Date().toISOString(),
            configHash: quickHash(configStr),
            files: fileEntries,
            report,
        };

        await fs.ensureDir(path.dirname(this.cachePath));
        await fs.writeJson(this.cachePath, cache);
    }

    /**
     * Invalidate the cache (e.g., for --no-cache).
     */
    async invalidate(): Promise<void> {
        try {
            await fs.remove(this.cachePath);
        } catch {
            // Ignore
        }
    }
}
