/**
 * SQLite storage layer for Rigour Brain.
 * Single file at ~/.rigour/rigour.db stores all scan history, findings,
 * learned patterns, and feedback. ACID-safe, portable, queryable.
 */
import path from 'path';
import os from 'os';
import fs from 'fs-extra';
import { createRequire } from 'module';

// better-sqlite3 is optional — graceful degradation if not installed.
// It's a native C++ addon that uses require() semantics, so we use createRequire.
let Database: any = null;
let _dbResolved = false;

function loadDatabase(): any {
    if (_dbResolved) return Database;
    _dbResolved = true;
    try {
        const require = createRequire(import.meta.url);
        Database = require('better-sqlite3');
    } catch {
        Database = null;
    }
    return Database;
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

export interface RigourDB {
    db: any;
    close(): void;
}

/**
 * Open (or create) the Rigour SQLite database.
 * Returns null if better-sqlite3 is not available.
 */
export function openDatabase(dbPath?: string): RigourDB | null {
    const Db = loadDatabase();
    if (!Db) return null;

    const resolvedPath = dbPath || DB_PATH;
    fs.ensureDirSync(path.dirname(resolvedPath));

    const db = new Db(resolvedPath);

    // WAL mode for better concurrent read performance
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    // Run schema creation + migrations
    db.exec(SCHEMA_SQL);
    runMigrations(db);

    return {
        db,
        close() {
            db.close();
        },
    };
}

/**
 * Run incremental schema migrations based on stored version.
 */
function runMigrations(db: any): void {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
    const current = row ? parseInt(row.value, 10) : 0;

    if (current < 1) {
        // v1: base schema (already created by SCHEMA_SQL)
        db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '1')").run();
    }
    if (current < 2) {
        // v2: retention indexes for compaction queries
        db.exec(`
            CREATE INDEX IF NOT EXISTS idx_findings_file ON findings(file);
            CREATE INDEX IF NOT EXISTS idx_scans_repo_ts ON scans(repo, timestamp);
        `);
        db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '2')").run();
    }
    // Future: if (current < 3) { ... ALTER TABLE ... }
}

/**
 * Compact the database — prune old data, reclaim disk space.
 * Retention policy: keep last `retainDays` of findings, merge old patterns.
 */
export function compactDatabase(retainDays = 90): CompactResult {
    const Db = loadDatabase();
    if (!Db) return { pruned: 0, patternsDecayed: 0, sizeBefore: 0, sizeAfter: 0 };

    const resolvedPath = DB_PATH;
    const sizeBefore = fs.existsSync(resolvedPath) ? fs.statSync(resolvedPath).size : 0;
    const db = new Db(resolvedPath);
    db.pragma('journal_mode = WAL');

    const cutoff = Date.now() - (retainDays * 24 * 60 * 60 * 1000);
    let pruned = 0;
    let patternsDecayed = 0;

    try {
        db.transaction(() => {
            // 1. Delete old findings (keep scan records for trend lines)
            const r1 = db.prepare(`
                DELETE FROM findings WHERE scan_id IN (
                    SELECT id FROM scans WHERE timestamp < ?
                )
            `).run(cutoff);
            pruned += r1.changes;

            // 2. Prune weak patterns (never grew, seen < 3 times)
            const r2 = db.prepare(
                "DELETE FROM patterns WHERE strength < 0.3 AND times_seen < 3"
            ).run();
            patternsDecayed += r2.changes;

            // 3. Prune orphaned feedback
            db.prepare(
                "DELETE FROM feedback WHERE finding_id NOT IN (SELECT id FROM findings)"
            ).run();

            // 4. Prune old codebase index entries
            db.prepare("DELETE FROM codebase WHERE last_indexed < ?").run(cutoff);
        })();

        // 5. Reclaim disk space
        db.exec('VACUUM');
    } finally {
        db.close();
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
 * Check if SQLite is available (better-sqlite3 installed)
 */
export function isSQLiteAvailable(): boolean {
    return loadDatabase() !== null;
}

export { RIGOUR_DIR, DB_PATH };
