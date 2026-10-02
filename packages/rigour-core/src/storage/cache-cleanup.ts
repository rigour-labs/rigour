/**
 * Removing context-cache rows nothing reads: the static and component layers that index sync wrote
 * on every edit until it was removed (millions of rows, gigabytes, in real use).
 *
 * Built for a database that is large and a disk that is nearly full. Deleting the rows one by one
 * would copy every changed page into the write-ahead log (as much again on disk); instead the rows
 * worth keeping are set aside, the table is dropped (its pages are freed, not rewritten) and
 * recreated. VACUUM, which hands the freed space back to the disk, needs room for a copy of what
 * remains, so it runs only when that room exists.
 */
import fs from 'fs';
import path from 'path';
import { DB_PATH, openDatabase, type RigourDB } from './db.js';

/** Layers no reader uses (context/cache-engine.ts keeps only semantic and checkpoint). */
export const DEAD_CACHE_TYPES = ['static', 'component'] as const;
const DEAD_LIST = DEAD_CACHE_TYPES.map(t => `'${t}'`).join(', ');
/** VACUUM writes a copy of the live data; ask for that much free space, with headroom. */
const VACUUM_HEADROOM = 1.2;

export interface CacheCleanupReport {
    removed: number;
    kept: number;
    sizeBefore: number;
    sizeAfter: number;
    vacuumed: boolean;
    /** Why the file was not shrunk, when it was not. */
    vacuumSkipped?: string;
}

/** How many dead rows the database holds, and its size on disk; null when there is no database. */
export async function deadCacheRows(dbPath = DB_PATH): Promise<{ rows: number; bytes: number } | null> {
    if (!fs.existsSync(dbPath)) return null;
    const db = await openDatabase(dbPath);
    if (!db) return null;
    try {
        const row = await db.get(`SELECT COUNT(*) AS n FROM context_cache WHERE cache_type IN (${DEAD_LIST})`);
        return { rows: Number(row?.n ?? 0), bytes: fileBytes(dbPath) };
    } finally {
        await db.close();
    }
}

export async function cleanContextCache(dbPath = DB_PATH, freeBytes = freeSpace): Promise<CacheCleanupReport> {
    const sizeBefore = fileBytes(dbPath);
    const db = await openDatabase(dbPath);
    if (!db) return { removed: 0, kept: 0, sizeBefore, sizeAfter: sizeBefore, vacuumed: false, vacuumSkipped: 'SQLite is not available' };
    try {
        const { removed, kept } = await dropDeadRows(db);
        if (removed === 0) return { removed, kept, sizeBefore, sizeAfter: sizeBefore, vacuumed: false, vacuumSkipped: 'nothing to remove' };
        const live = await liveBytes(db);
        const available = freeBytes(path.dirname(dbPath));
        if (available < live * VACUUM_HEADROOM) {
            return { removed, kept, sizeBefore, sizeAfter: fileBytes(dbPath), vacuumed: false,
                vacuumSkipped: `needs about ${mb(live * VACUUM_HEADROOM)} free to shrink the file, ${mb(available)} available; the space is reused by Rigour either way` };
        }
        await db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
        await db.exec('VACUUM');
        await db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
        return { removed, kept, sizeBefore, sizeAfter: fileBytes(dbPath), vacuumed: true };
    } finally {
        await db.close();
    }
}

/** Set the readable rows aside, drop the table, recreate it with its indexes, put them back. */
async function dropDeadRows(db: RigourDB): Promise<{ removed: number; kept: number }> {
    return db.transaction(async (tx) => {
        const removed = Number((await tx.get(`SELECT COUNT(*) AS n FROM context_cache WHERE cache_type IN (${DEAD_LIST})`))?.n ?? 0);
        if (removed === 0) return { removed, kept: 0 };
        const schema = await tx.all(`SELECT sql FROM sqlite_master WHERE tbl_name = 'context_cache' AND sql IS NOT NULL ORDER BY type DESC`);
        await tx.exec(`CREATE TEMP TABLE context_cache_keep AS SELECT * FROM context_cache WHERE cache_type NOT IN (${DEAD_LIST})`);
        await tx.exec('DROP TABLE context_cache');
        for (const { sql } of schema) await tx.exec(sql); // the table first (type 'table' sorts after 'index' descending), then its indexes
        await tx.exec('INSERT INTO context_cache SELECT * FROM context_cache_keep');
        const kept = Number((await tx.get('SELECT COUNT(*) AS n FROM context_cache'))?.n ?? 0);
        await tx.exec('DROP TABLE context_cache_keep');
        return { removed, kept };
    });
}

async function liveBytes(db: RigourDB): Promise<number> {
    const pages = Number((await db.get('PRAGMA page_count'))?.page_count ?? 0);
    const free = Number((await db.get('PRAGMA freelist_count'))?.freelist_count ?? 0);
    const size = Number((await db.get('PRAGMA page_size'))?.page_size ?? 4096);
    return (pages - free) * size;
}

function fileBytes(dbPath: string): number {
    return [dbPath, `${dbPath}-wal`].reduce((n, f) => n + (fs.existsSync(f) ? fs.statSync(f).size : 0), 0);
}

function freeSpace(dir: string): number {
    const stats = fs.statfsSync(dir);
    return Number(stats.bavail) * Number(stats.bsize);
}

function mb(bytes: number): string {
    return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
}
