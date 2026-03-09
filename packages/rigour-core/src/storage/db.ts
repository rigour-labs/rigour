/**
 * SQLite storage layer for Rigour Brain.
 * Single file at ~/.rigour/rigour.db stores all scan history, findings,
 * learned patterns, and feedback. ACID-safe, portable, queryable.
 *
 * Uses node-sqlite3 (async, widely supported, no native build issues).
 * All public APIs are async. Graceful degradation if sqlite3 not installed.
 */
import path from 'path';
import os from 'os';
import fs from 'fs-extra';
import { createRequire } from 'module';

// ---------------------------------------------------------------------------
// Optional dynamic import of sqlite3
// ---------------------------------------------------------------------------
let sqlite3Module: any = null;
let _resolved = false;

function loadSqlite3(): any {
    if (_resolved) return sqlite3Module;
    _resolved = true;
    try {
        const require = createRequire(import.meta.url);
        sqlite3Module = require('sqlite3');
    } catch {
        sqlite3Module = null;
    }
    return sqlite3Module;
}

const RIGOUR_DIR = path.join(os.homedir(), '.rigour');
const DB_PATH = path.join(RIGOUR_DIR, 'rigour.db');

/** Current schema version — bump when adding migrations. */
const SCHEMA_VERSION = 2;

const SCHEMA_SQL = `
-- Schema version tracking
CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- Every scan result, forever
CREATE TABLE IF NOT EXISTS scans (
    id TEXT PRIMARY KEY,
    repo TEXT NOT NULL,
    commit_hash TEXT,
    timestamp INTEGER NOT NULL,
    ai_health_score INTEGER,
    code_quality_score INTEGER,
    overall_score INTEGER,
    files_scanned INTEGER,
    duration_ms INTEGER,
    deep_tier TEXT,
    deep_model TEXT
);

-- Every finding from every scan
CREATE TABLE IF NOT EXISTS findings (
    id TEXT PRIMARY KEY,
    scan_id TEXT REFERENCES scans(id),
    file TEXT NOT NULL,
    line INTEGER,
    category TEXT NOT NULL,
    severity TEXT NOT NULL,
    source TEXT NOT NULL,
    provenance TEXT,
    description TEXT,
    suggestion TEXT,
    confidence REAL,
    verified INTEGER DEFAULT 0
);

-- Learned patterns (the Brain's memory)
CREATE TABLE IF NOT EXISTS patterns (
    id TEXT PRIMARY KEY,
    repo TEXT,
    pattern TEXT NOT NULL,
    description TEXT,
    strength REAL DEFAULT 0.3,
    times_seen INTEGER DEFAULT 1,
    first_seen INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    source TEXT NOT NULL
);

-- Human feedback on findings
CREATE TABLE IF NOT EXISTS feedback (
    id TEXT PRIMARY KEY,
    finding_id TEXT REFERENCES findings(id),
    rating TEXT NOT NULL,
    comment TEXT,
    timestamp INTEGER NOT NULL
);

-- Codebase index (AST graph)
CREATE TABLE IF NOT EXISTS codebase (
    id TEXT PRIMARY KEY,
    repo TEXT NOT NULL,
    file TEXT NOT NULL,
    functions TEXT,
    imports TEXT,
    exports TEXT,
    complexity_metrics TEXT,
    last_indexed INTEGER NOT NULL
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_scans_repo ON scans(repo);
CREATE INDEX IF NOT EXISTS idx_scans_timestamp ON scans(timestamp);
CREATE INDEX IF NOT EXISTS idx_findings_scan ON findings(scan_id);
CREATE INDEX IF NOT EXISTS idx_findings_category ON findings(category);
CREATE INDEX IF NOT EXISTS idx_patterns_repo ON patterns(repo);
CREATE INDEX IF NOT EXISTS idx_patterns_strength ON patterns(strength);
`;

// ---------------------------------------------------------------------------
// Async wrapper around node-sqlite3
// ---------------------------------------------------------------------------

/**
 * Promisified wrapper around a node-sqlite3 Database instance.
 * Provides run/get/all/exec methods that return Promises.
 */
export interface RigourDB {
    /** Execute a write statement (INSERT/UPDATE/DELETE). Returns { changes }. */
    run(sql: string, ...params: any[]): Promise<{ changes: number; lastID: number }>;
    /** Fetch a single row. */
    get(sql: string, ...params: any[]): Promise<any>;
    /** Fetch all rows. */
    all(sql: string, ...params: any[]): Promise<any[]>;
    /** Execute raw SQL (multi-statement OK). */
    exec(sql: string): Promise<void>;
    /** Close the database connection. */
    close(): Promise<void>;
    /** Run multiple operations atomically via BEGIN/COMMIT/ROLLBACK. */
    transaction<T>(fn: (db: RigourDB) => Promise<T>): Promise<T>;
}

function wrapDatabase(raw: any): RigourDB {
    const db: RigourDB = {
        run(sql: string, ...params: any[]) {
            return new Promise((resolve, reject) => {
                raw.run(sql, ...params, function (this: any, err: Error | null) {
                    if (err) return reject(err);
                    resolve({ changes: this.changes, lastID: this.lastID });
                });
            });
        },
        get(sql: string, ...params: any[]) {
            return new Promise((resolve, reject) => {
                raw.get(sql, ...params, (err: Error | null, row: any) => {
                    if (err) return reject(err);
                    resolve(row);
                });
            });
        },
        all(sql: string, ...params: any[]) {
            return new Promise((resolve, reject) => {
                raw.all(sql, ...params, (err: Error | null, rows: any[]) => {
                    if (err) return reject(err);
                    resolve(rows || []);
                });
            });
        },
        exec(sql: string) {
            return new Promise((resolve, reject) => {
                raw.exec(sql, (err: Error | null) => {
                    if (err) return reject(err);
                    resolve();
                });
            });
        },
        close() {
            return new Promise((resolve, reject) => {
                raw.close((err: Error | null) => {
                    if (err) return reject(err);
                    resolve();
                });
            });
        },
        async transaction<T>(fn: (db: RigourDB) => Promise<T>): Promise<T> {
            await db.exec('BEGIN TRANSACTION');
            try {
                const result = await fn(db);
                await db.exec('COMMIT');
                return result;
            } catch (err) {
                await db.exec('ROLLBACK');
                throw err;
            }
        },
    };
    return db;
}

/**
 * Open (or create) the Rigour SQLite database.
 * Returns null if sqlite3 is not available.
 */
export async function openDatabase(dbPath?: string): Promise<RigourDB | null> {
    const sqlite3 = loadSqlite3();
    if (!sqlite3) return null;

    const resolvedPath = dbPath || DB_PATH;
    fs.ensureDirSync(path.dirname(resolvedPath));

    const raw = await new Promise<any>((resolve, reject) => {
        const instance = new sqlite3.Database(resolvedPath, (err: Error | null) => {
            if (err) return reject(err);
            resolve(instance);
        });
    });

    const db = wrapDatabase(raw);

    // WAL mode for better concurrent read performance
    await db.exec('PRAGMA journal_mode = WAL');
    await db.exec('PRAGMA foreign_keys = ON');

    // Run schema creation + migrations
    await db.exec(SCHEMA_SQL);
    await runMigrations(db);

    return db;
}

/**
 * Run incremental schema migrations based on stored version.
 */
async function runMigrations(db: RigourDB): Promise<void> {
    const row = await db.get("SELECT value FROM meta WHERE key = 'schema_version'");
    const current = row ? parseInt(row.value, 10) : 0;

    if (current < 1) {
        await db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '1')");
    }
    if (current < 2) {
        await db.exec(`
            CREATE INDEX IF NOT EXISTS idx_findings_file ON findings(file);
            CREATE INDEX IF NOT EXISTS idx_scans_repo_ts ON scans(repo, timestamp);
        `);
        await db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '2')");
    }
    // Future: if (current < 3) { ... ALTER TABLE ... }
}

/**
 * Compact the database — prune old data, reclaim disk space.
 */
export async function compactDatabase(retainDays = 90): Promise<CompactResult> {
    const sqlite3 = loadSqlite3();
    if (!sqlite3) return { pruned: 0, patternsDecayed: 0, sizeBefore: 0, sizeAfter: 0 };

    const resolvedPath = DB_PATH;
    const sizeBefore = fs.existsSync(resolvedPath) ? fs.statSync(resolvedPath).size : 0;

    const db = await openDatabase(resolvedPath);
    if (!db) return { pruned: 0, patternsDecayed: 0, sizeBefore, sizeAfter: sizeBefore };

    const cutoff = Date.now() - (retainDays * 24 * 60 * 60 * 1000);
    let pruned = 0;
    let patternsDecayed = 0;

    try {
        await db.transaction(async (tx) => {
            const r1 = await tx.run(`
                DELETE FROM findings WHERE scan_id IN (
                    SELECT id FROM scans WHERE timestamp < ?
                )
            `, cutoff);
            pruned += r1.changes;

            const r2 = await tx.run(
                "DELETE FROM patterns WHERE strength < 0.3 AND times_seen < 3"
            );
            patternsDecayed += r2.changes;

            await tx.run(
                "DELETE FROM feedback WHERE finding_id NOT IN (SELECT id FROM findings)"
            );

            await tx.run("DELETE FROM codebase WHERE last_indexed < ?", cutoff);
        });

        await db.exec('VACUUM');
    } finally {
        await db.close();
    }

    const sizeAfter = fs.existsSync(resolvedPath) ? fs.statSync(resolvedPath).size : 0;
    return { pruned, patternsDecayed, sizeBefore, sizeAfter };
}

export interface CompactResult {
    pruned: number;
    patternsDecayed: number;
    sizeBefore: number;
    sizeAfter: number;
}

/**
 * Get database file size in bytes. Returns 0 if DB doesn't exist.
 */
export function getDatabaseSize(): number {
    return fs.existsSync(DB_PATH) ? fs.statSync(DB_PATH).size : 0;
}

/**
 * Reset the database — delete and recreate from scratch.
 */
export function resetDatabase(): void {
    if (fs.existsSync(DB_PATH)) fs.removeSync(DB_PATH);
    if (fs.existsSync(DB_PATH + '-wal')) fs.removeSync(DB_PATH + '-wal');
    if (fs.existsSync(DB_PATH + '-shm')) fs.removeSync(DB_PATH + '-shm');
}

/**
 * Check if SQLite is available (sqlite3 installed)
 */
export function isSQLiteAvailable(): boolean {
    return loadSqlite3() !== null;
}

export { RIGOUR_DIR, DB_PATH };
