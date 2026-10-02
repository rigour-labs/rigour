import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanContextCache, deadCacheRows } from './cache-cleanup.js';
import { openDatabase } from './db.js';

let dir: string;
let dbPath: string;

async function seed(rows: Array<[string, string]>): Promise<void> {
    const db = (await openDatabase(dbPath))!;
    for (const [key, type] of rows) {
        await db.run(
            `INSERT INTO context_cache (cache_key, cache_type, repo, branch, dependency_fingerprint, payload_json, payload_tokens, created_at)
             VALUES (?, ?, 'r', 'main', 'f', ?, 1, 0)`, key, type, JSON.stringify({ padding: 'x'.repeat(2000) }));
    }
    await db.close();
}

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-cleanup-')); // a temporary database: never ~/.rigour
    dbPath = path.join(dir, 'rigour.db');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('cleanContextCache', () => {
    it('removes the unread layers, keeps the readable rows and the indexes, and shrinks the file', async () => {
        await seed([
            ...Array.from({ length: 400 }, (_, i) => [`static:${i}`, 'static'] as [string, string]),
            ...Array.from({ length: 400 }, (_, i) => [`component:${i}`, 'component'] as [string, string]),
            ['semantic:a', 'semantic'], ['checkpoint:b', 'checkpoint'],
        ]);
        expect(await deadCacheRows(dbPath)).toMatchObject({ rows: 800 });

        const report = await cleanContextCache(dbPath, () => Number.MAX_SAFE_INTEGER);
        expect(report).toMatchObject({ removed: 800, kept: 2, vacuumed: true });
        expect(report.sizeAfter).toBeLessThan(report.sizeBefore);

        const db = (await openDatabase(dbPath))!;
        expect((await db.all('SELECT cache_key FROM context_cache ORDER BY cache_key')).map(r => r.cache_key)).toEqual(['checkpoint:b', 'semantic:a']);
        expect((await db.all("SELECT name FROM sqlite_master WHERE tbl_name = 'context_cache' AND type = 'index'")).map(r => r.name)).toContain('idx_context_cache_type');
        await db.close();
        expect(await deadCacheRows(dbPath)).toMatchObject({ rows: 0 });
    });

    it('still removes the rows but leaves the file size alone when the disk lacks room to shrink it', async () => {
        await seed([['static:1', 'static'], ['semantic:a', 'semantic']]);
        const report = await cleanContextCache(dbPath, () => 0);
        expect(report).toMatchObject({ removed: 1, kept: 1, vacuumed: false });
        expect(report.vacuumSkipped).toContain('free to shrink the file');
    });

    it('does nothing when there is nothing to remove', async () => {
        await seed([['semantic:a', 'semantic']]);
        expect(await cleanContextCache(dbPath, () => 0)).toMatchObject({ removed: 0, vacuumed: false, vacuumSkipped: 'nothing to remove' });
    });
});
