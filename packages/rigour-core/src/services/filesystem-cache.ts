/**
 * FileSystemCache — Shared file content cache across gates
 *
 * Solves the memory problem: each gate was independently loading ALL files
 * into a Map<string, string>. With 25+ gates, a 5000-file repo would
 * allocate ~500MB+ (50MB per gate × 10 gates reading files).
 *
 * Now: one cache per scan, all gates share it. LRU eviction keeps
 * memory bounded. Hit rate >70% by the 2nd gate.
 *
 * @since v5.0.0
 */

import fs from 'fs-extra';
import path from 'path';

export interface CacheStats {
    hits: number;
    misses: number;
    evictions: number;
    entries: number;
    estimatedSizeBytes: number;
}

export class FileSystemCache {
    private cache = new Map<string, string>();
    private accessOrder: string[] = [];
    private stats: CacheStats = { hits: 0, misses: 0, evictions: 0, entries: 0, estimatedSizeBytes: 0 };

    constructor(
        private readonly maxEntries: number = 2000,
        private readonly maxSizeBytes: number = 200 * 1024 * 1024 // 200MB default
    ) {}

    /**
     * Get a single file's content. Reads from disk on cache miss.
     */
    async getFile(absolutePath: string): Promise<string> {
        const cached = this.cache.get(absolutePath);
        if (cached !== undefined) {
            this.stats.hits++;
            this.touch(absolutePath);
            return cached;
        }

        this.stats.misses++;
        const content = await fs.readFile(absolutePath, 'utf-8');
        this.put(absolutePath, content);
        return content;
    }

    /**
     * Get multiple files. Compatible with FileScanner.readFiles() return type.
     */
    async getFiles(cwd: string, files: string[]): Promise<Map<string, string>> {
        const contents = new Map<string, string>();
        for (const file of files) {
            const normalizedFile = file.replace(/\//g, path.sep);
            const filePath = path.isAbsolute(normalizedFile) ? normalizedFile : path.join(cwd, normalizedFile);
            try {
                contents.set(file, await this.getFile(filePath));
            } catch {
                // File not readable — skip (same behavior as original scanner)
            }
        }
        return contents;
    }

    /**
     * Invalidate a specific file or the entire cache.
     */
    invalidate(absolutePath?: string): void {
        if (absolutePath) {
            const content = this.cache.get(absolutePath);
            if (content) {
                this.stats.estimatedSizeBytes -= content.length * 2; // UTF-16
                this.cache.delete(absolutePath);
                this.accessOrder = this.accessOrder.filter(k => k !== absolutePath);
                this.stats.entries--;
            }
        } else {
            this.cache.clear();
            this.accessOrder = [];
            this.stats.entries = 0;
            this.stats.estimatedSizeBytes = 0;
        }
    }

    /**
     * Get cache statistics for monitoring.
     */
    getStats(): CacheStats {
        return { ...this.stats };
    }

    /**
     * Hit rate as a percentage (0-100).
     */
    get hitRate(): number {
        const total = this.stats.hits + this.stats.misses;
        return total === 0 ? 0 : Math.round((this.stats.hits / total) * 100);
    }

    // ─── Internal LRU Logic ─────────────────────────────────────────

    private put(key: string, content: string): void {
        const sizeBytes = content.length * 2; // UTF-16 estimate

        // Evict if over limits
        while (
            (this.cache.size >= this.maxEntries || this.stats.estimatedSizeBytes + sizeBytes > this.maxSizeBytes) &&
            this.accessOrder.length > 0
        ) {
            this.evictLRU();
        }

        this.cache.set(key, content);
        this.accessOrder.push(key);
        this.stats.entries = this.cache.size;
        this.stats.estimatedSizeBytes += sizeBytes;
    }

    private touch(key: string): void {
        // Move to end of access order (most recently used)
        const idx = this.accessOrder.indexOf(key);
        if (idx !== -1) {
            this.accessOrder.splice(idx, 1);
            this.accessOrder.push(key);
        }
    }

    private evictLRU(): void {
        const oldest = this.accessOrder.shift();
        if (oldest) {
            const content = this.cache.get(oldest);
            if (content) {
                this.stats.estimatedSizeBytes -= content.length * 2;
            }
            this.cache.delete(oldest);
            this.stats.evictions++;
            this.stats.entries = this.cache.size;
        }
    }
}
