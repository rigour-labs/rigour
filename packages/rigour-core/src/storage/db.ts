/**
 * SQLite storage layer for Rigour Brain.
 * Single file at ~/.rigour/rigour.db stores all scan history, findings,
 * learned patterns, and feedback. ACID-safe, portable, queryable.
 *
 * Uses Node's built-in SQLite (node:sqlite): nothing to install or compile, and no native addon to
 * crash a worker thread. All public APIs are async. Where node:sqlite is missing (Node before
 * 22.13), storage is off and every caller degrades as before.
 */
import path from 'path';
import fs from 'fs-extra';
import { createRequire } from 'module';
import { rigourUserDir } from '../utils/user-state.js';

type DatabaseSync = import('node:sqlite').DatabaseSync;
type SQLInputValue = import('node:sqlite').SQLInputValue;

let sqliteModule: typeof import('node:sqlite') | null | undefined;

/**
 * node:sqlite, or null where this Node has none. Node 22 prints an "experimental feature" warning on
 * the first load; it says nothing a Rigour user can act on, so that one warning is not shown.
 */
function loadSqlite(): typeof import('node:sqlite') | null {
    if (sqliteModule !== undefined) return sqliteModule;
    const emitWarning = process.emitWarning;
    process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
        if (String((warning as Error)?.message ?? warning).startsWith('SQLite is an experimental feature')) return;
        return (emitWarning as (...args: unknown[]) => void).call(process, warning, ...rest);
    }) as typeof process.emitWarning;
    try {
        sqliteModule = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
    } catch {
        sqliteModule = null;
    } finally {
        process.emitWarning = emitWarning;
    }
    return sqliteModule;
}

// RIGOUR_HOME when set (tests, sandboxes) so nothing but a real run touches ~/.rigour.
const RIGOUR_DIR = rigourUserDir();
const DB_PATH = path.join(RIGOUR_DIR, 'rigour.db');

/** Current schema version — bump when adding migrations. */
const SCHEMA_VERSION = 7;

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

-- Rigour Telemetry: Avoided and observed context events
CREATE TABLE IF NOT EXISTS context_events (
    id TEXT PRIMARY KEY,
    task_id TEXT,
    session_id TEXT,
    agent_id TEXT,
    tool_name TEXT NOT NULL,
    query_hash TEXT,
    cache_status TEXT NOT NULL,
    candidate_tokens INTEGER NOT NULL DEFAULT 0,
    returned_tokens INTEGER NOT NULL DEFAULT 0,
    deduplicated_tokens INTEGER NOT NULL DEFAULT 0,
    candidate_files INTEGER NOT NULL DEFAULT 0,
    returned_files INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
);

-- Cursor / Model Usage telemetry
CREATE TABLE IF NOT EXISTS model_usage (
    id TEXT PRIMARY KEY,
    task_id TEXT,
    session_id TEXT,
    agent_id TEXT,
    provider TEXT,
    model TEXT,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cached_input_tokens INTEGER,
    observed_cost_usd REAL,
    source TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

-- 4-Layer Context Cache
CREATE TABLE IF NOT EXISTS context_cache (
    cache_key TEXT PRIMARY KEY,
    cache_type TEXT NOT NULL,
    repo TEXT NOT NULL,
    branch TEXT NOT NULL,
    commit_sha TEXT,
    dependency_fingerprint TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    payload_tokens INTEGER NOT NULL,
    hit_count INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    last_hit_at INTEGER
);

-- Checkpoint compression metrics
CREATE TABLE IF NOT EXISTS checkpoint_metrics (
    checkpoint_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    raw_state_tokens INTEGER,
    checkpoint_tokens INTEGER NOT NULL,
    replay_tokens_avoided INTEGER,
    created_at INTEGER NOT NULL
);

-- Evidence-gated learning produced during normal agent interaction.
CREATE TABLE IF NOT EXISTS lessons (
    id TEXT PRIMARY KEY,
    repository_id TEXT NOT NULL,
    actor_id TEXT,
    team_id TEXT,
    visibility TEXT NOT NULL DEFAULT 'personal',
    state TEXT NOT NULL DEFAULT 'candidate',
    kind TEXT NOT NULL,
    subject TEXT NOT NULL,
    evidence_json TEXT NOT NULL,
    confidence REAL NOT NULL DEFAULT 0.3,
    source TEXT NOT NULL,
    supersedes_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_outbox (
    id TEXT PRIMARY KEY,
    operation TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    synced_at INTEGER
);

-- Stable repository registry used by cross-project learning and graph views.
CREATE TABLE IF NOT EXISTS repositories (
    id TEXT PRIMARY KEY,
    canonical_uri TEXT NOT NULL,
    display_name TEXT NOT NULL,
    last_seen INTEGER NOT NULL
);

-- Append-only observations from normal governed agent work. These are evidence,
-- not reusable rules; lesson promotion remains a separate gated decision.
CREATE TABLE IF NOT EXISTS interaction_events (
    id TEXT PRIMARY KEY,
    repository_id TEXT NOT NULL,
    actor_id TEXT,
    task_id TEXT,
    session_id TEXT,
    request_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    phase TEXT NOT NULL,
    outcome TEXT NOT NULL,
    deterministic INTEGER NOT NULL DEFAULT 0,
    evidence_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_scans_repo ON scans(repo);
CREATE INDEX IF NOT EXISTS idx_scans_timestamp ON scans(timestamp);
CREATE INDEX IF NOT EXISTS idx_findings_scan ON findings(scan_id);
CREATE INDEX IF NOT EXISTS idx_findings_category ON findings(category);
CREATE INDEX IF NOT EXISTS idx_patterns_repo ON patterns(repo);
CREATE INDEX IF NOT EXISTS idx_patterns_strength ON patterns(strength);
CREATE INDEX IF NOT EXISTS idx_context_events_task ON context_events(task_id);
CREATE INDEX IF NOT EXISTS idx_context_events_session ON context_events(session_id);
CREATE INDEX IF NOT EXISTS idx_context_events_agent ON context_events(agent_id);
CREATE INDEX IF NOT EXISTS idx_context_events_created ON context_events(created_at);
CREATE INDEX IF NOT EXISTS idx_model_usage_task ON model_usage(task_id);
CREATE INDEX IF NOT EXISTS idx_model_usage_created ON model_usage(created_at);
CREATE INDEX IF NOT EXISTS idx_context_cache_type ON context_cache(cache_type);
CREATE INDEX IF NOT EXISTS idx_checkpoint_metrics_task ON checkpoint_metrics(task_id);
CREATE INDEX IF NOT EXISTS idx_lessons_lookup ON lessons(repository_id, actor_id, team_id, state);
CREATE INDEX IF NOT EXISTS idx_sync_outbox_pending ON sync_outbox(synced_at, created_at);
CREATE INDEX IF NOT EXISTS idx_repositories_last_seen ON repositories(last_seen);
CREATE INDEX IF NOT EXISTS idx_interaction_events_repo_created ON interaction_events(repository_id, created_at);
CREATE INDEX IF NOT EXISTS idx_interaction_events_request ON interaction_events(request_id);
`;

// ---------------------------------------------------------------------------
// Async wrapper around node:sqlite
// ---------------------------------------------------------------------------

/**
 * The database behind a promise API: run/get/all/exec return Promises, so callers do not change
 * with the driver, and a later move to a worker or an async driver stays inside this file.
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

/**
 * A value as SQLite stores it. node:sqlite refuses what sqlite3 converted silently, so the same
 * conversions happen here: undefined is NULL, a boolean is 1 or 0, a Date is its epoch milliseconds.
 */
function bindable(value: unknown): SQLInputValue {
    if (value === undefined) return null;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (value instanceof Date) return value.getTime();
    return value as SQLInputValue;
}

/** Rows as plain objects (node:sqlite returns them without a prototype). */
function plain<T>(row: T): T {
    return row && typeof row === 'object' ? { ...row } : row;
}

function wrapDatabase(raw: DatabaseSync): RigourDB {
    const prepare = (sql: string) => raw.prepare(sql);
    const db: RigourDB = {
        async run(sql: string, ...params: any[]) {
            const result = prepare(sql).run(...params.map(bindable));
            return { changes: Number(result.changes), lastID: Number(result.lastInsertRowid) };
        },
        async get(sql: string, ...params: any[]) {
            return plain(prepare(sql).get(...params.map(bindable)));
        },
        async all(sql: string, ...params: any[]) {
            return prepare(sql).all(...params.map(bindable)).map(plain);
        },
        async exec(sql: string) {
            raw.exec(sql);
        },
        async close() {
            raw.close();
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
 * Returns null where this Node has no node:sqlite.
 */
export async function openDatabase(dbPath?: string): Promise<RigourDB | null> {
    const sqlite = loadSqlite();
    if (!sqlite) return null;

    const resolvedPath = dbPath || DB_PATH;
    fs.ensureDirSync(path.dirname(resolvedPath));

    const db = wrapDatabase(new sqlite.DatabaseSync(resolvedPath));

    // Wait for a lock instead of failing at once: a hook and an MCP server often open the database
    // at the same moment, and without this the second open fails with SQLITE_BUSY.
    await db.exec('PRAGMA busy_timeout = 5000');
    // WAL mode for better concurrent read performance
    await enableWal(db);
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
    if (current < 3) {
        await db.exec(`
            CREATE TABLE IF NOT EXISTS context_events (
                id TEXT PRIMARY KEY,
                task_id TEXT,
                session_id TEXT,
                agent_id TEXT,
                tool_name TEXT NOT NULL,
                query_hash TEXT,
                cache_status TEXT NOT NULL,
                candidate_tokens INTEGER NOT NULL DEFAULT 0,
                returned_tokens INTEGER NOT NULL DEFAULT 0,
                deduplicated_tokens INTEGER NOT NULL DEFAULT 0,
                candidate_files INTEGER NOT NULL DEFAULT 0,
                returned_files INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS model_usage (
                id TEXT PRIMARY KEY,
                task_id TEXT,
                session_id TEXT,
                agent_id TEXT,
                provider TEXT,
                model TEXT,
                input_tokens INTEGER,
                output_tokens INTEGER,
                cached_input_tokens INTEGER,
                observed_cost_usd REAL,
                source TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS context_cache (
                cache_key TEXT PRIMARY KEY,
                cache_type TEXT NOT NULL,
                repo TEXT NOT NULL,
                branch TEXT NOT NULL,
                commit_sha TEXT,
                dependency_fingerprint TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                payload_tokens INTEGER NOT NULL,
                hit_count INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,
                last_hit_at INTEGER
            );
            CREATE TABLE IF NOT EXISTS checkpoint_metrics (
                checkpoint_id TEXT PRIMARY KEY,
                task_id TEXT NOT NULL,
                agent_id TEXT NOT NULL,
                raw_state_tokens INTEGER,
                checkpoint_tokens INTEGER NOT NULL,
                replay_tokens_avoided INTEGER,
                created_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_context_events_task ON context_events(task_id);
            CREATE INDEX IF NOT EXISTS idx_context_events_session ON context_events(session_id);
            CREATE INDEX IF NOT EXISTS idx_context_events_agent ON context_events(agent_id);
            CREATE INDEX IF NOT EXISTS idx_context_events_created ON context_events(created_at);
            CREATE INDEX IF NOT EXISTS idx_model_usage_task ON model_usage(task_id);
            CREATE INDEX IF NOT EXISTS idx_model_usage_created ON model_usage(created_at);
            CREATE INDEX IF NOT EXISTS idx_context_cache_type ON context_cache(cache_type);
            CREATE INDEX IF NOT EXISTS idx_checkpoint_metrics_task ON checkpoint_metrics(task_id);
        `);
        await db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '3')");
    }
    if (current < 4) {
        await db.exec(`
            CREATE INDEX IF NOT EXISTS idx_context_events_session ON context_events(session_id);
            CREATE INDEX IF NOT EXISTS idx_context_events_created ON context_events(created_at);
            CREATE INDEX IF NOT EXISTS idx_model_usage_created ON model_usage(created_at);
        `);
        await db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '4')");
    }
    if (current < 5) {
        await db.exec(`
            CREATE TABLE IF NOT EXISTS lessons (
                id TEXT PRIMARY KEY,
                repository_id TEXT NOT NULL,
                actor_id TEXT,
                team_id TEXT,
                visibility TEXT NOT NULL DEFAULT 'personal',
                state TEXT NOT NULL DEFAULT 'candidate',
                kind TEXT NOT NULL,
                subject TEXT NOT NULL,
                evidence_json TEXT NOT NULL,
                confidence REAL NOT NULL DEFAULT 0.3,
                source TEXT NOT NULL,
                supersedes_id TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sync_outbox (
                id TEXT PRIMARY KEY,
                operation TEXT NOT NULL,
                entity_type TEXT NOT NULL,
                entity_id TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                attempts INTEGER NOT NULL DEFAULT 0,
                last_error TEXT,
                created_at INTEGER NOT NULL,
                synced_at INTEGER
            );
            CREATE INDEX IF NOT EXISTS idx_lessons_lookup ON lessons(repository_id, actor_id, team_id, state);
            CREATE INDEX IF NOT EXISTS idx_sync_outbox_pending ON sync_outbox(synced_at, created_at);
        `);
        await db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '5')");
    }
    if (current < 6) {
        await db.exec(`
            CREATE TABLE IF NOT EXISTS repositories (
                id TEXT PRIMARY KEY,
                canonical_uri TEXT NOT NULL,
                display_name TEXT NOT NULL,
                last_seen INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_repositories_last_seen ON repositories(last_seen);
        `);
        await db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '6')");
    }
    if (current < 7) {
        await db.exec(`
            CREATE TABLE IF NOT EXISTS interaction_events (
                id TEXT PRIMARY KEY,
                repository_id TEXT NOT NULL,
                actor_id TEXT,
                task_id TEXT,
                session_id TEXT,
                request_id TEXT NOT NULL,
                tool_name TEXT NOT NULL,
                phase TEXT NOT NULL,
                outcome TEXT NOT NULL,
                deterministic INTEGER NOT NULL DEFAULT 0,
                evidence_json TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_interaction_events_repo_created
                ON interaction_events(repository_id, created_at);
            CREATE INDEX IF NOT EXISTS idx_interaction_events_request
                ON interaction_events(request_id);
        `);
        await db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '7')");
    }
    if (current < 8) {
        // Telemetry rows record their repository, so Studio shows this repository's numbers, not
        // every repository's on the machine. Older rows stay NULL and are left out of per-repo views.
        await addColumnIfMissing(db, 'context_events', 'repository_id', 'ALTER TABLE context_events ADD COLUMN repository_id TEXT');
        await addColumnIfMissing(db, 'model_usage', 'repository_id', 'ALTER TABLE model_usage ADD COLUMN repository_id TEXT');
        await addColumnIfMissing(db, 'checkpoint_metrics', 'repository_id', 'ALTER TABLE checkpoint_metrics ADD COLUMN repository_id TEXT');
        await db.exec(`
            CREATE INDEX IF NOT EXISTS idx_context_events_repo ON context_events(repository_id, created_at);
            CREATE INDEX IF NOT EXISTS idx_model_usage_repo ON model_usage(repository_id, created_at);
            CREATE INDEX IF NOT EXISTS idx_checkpoint_metrics_repo ON checkpoint_metrics(repository_id, created_at);
        `);
        await db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '8')");
    }
}

/**
 * Switch to WAL. On a new database, two connections switching at once make the second fail with
 * SQLITE_BUSY at once (busy_timeout does not cover a journal-mode change), so retry briefly; the
 * mode is persistent, so once either succeeds, every later open finds WAL already set.
 */
async function enableWal(db: RigourDB, attempts = 10): Promise<void> {
    for (let attempt = 1; ; attempt++) {
        try {
            await db.exec('PRAGMA journal_mode = WAL');
            return;
        } catch (error) {
            if (!/SQLITE_BUSY|database is locked/i.test(String(error)) || attempt >= attempts) throw error;
            await new Promise(resolve => setTimeout(resolve, 25 * attempt));
        }
    }
}

/**
 * Add a column unless it is there: a hook and an MCP server can open the database at once, and
 * both may run the same migration; a second plain ALTER would fail with "duplicate column".
 */
async function addColumnIfMissing(db: RigourDB, table: string, column: string, alterSql: string): Promise<void> {
    // The table is a bound parameter and the ALTER a literal written by the caller: nothing is interpolated.
    const columns = await db.all('SELECT name FROM pragma_table_info(?)', table);
    if (columns.some((c: { name: string }) => c.name === column)) return;
    try {
        await db.exec(alterSql);
    } catch (error) {
        if (!/duplicate column/i.test(String(error))) throw error;
    }
}

/**
 * Compact the database — prune old data, reclaim disk space.
 */
export async function compactDatabase(retainDays = 90): Promise<CompactResult> {
    if (!loadSqlite()) return { pruned: 0, patternsDecayed: 0, sizeBefore: 0, sizeAfter: 0 };

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

/** Whether this Node has SQLite (node:sqlite, Node 22.13 or later). */
export function isSQLiteAvailable(): boolean {
    return loadSqlite() !== null;
}

export { RIGOUR_DIR, DB_PATH };
