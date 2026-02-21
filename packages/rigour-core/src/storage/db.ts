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

const SCHEMA_SQL = `
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

    // Run schema migration
    db.exec(SCHEMA_SQL);

    return {
        db,
        close() {
            db.close();
        },
    };
}

/**
 * Check if SQLite is available (better-sqlite3 installed)
 */
export function isSQLiteAvailable(): boolean {
    return loadDatabase() !== null;
}

export { RIGOUR_DIR, DB_PATH };
