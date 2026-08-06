/**
 * Context Telemetry & Avoided Token Database Access Layer
 * Stores and queries context events, model usage, context caches, and checkpoint metrics.
 */
import { randomUUID } from 'crypto';
import fs from 'fs-extra';
import path from 'path';
import { openDatabase, isSQLiteAvailable, DB_PATH } from './db.js';

export interface ContextEvent {
    id?: string;
    taskId?: string;
    sessionId?: string;
    agentId?: string;
    toolName: string;
    queryHash?: string;
    cacheStatus: 'exact-hit' | 'semantic-hit' | 'partial-hit' | 'miss' | 'none';
    candidateTokens: number;
    returnedTokens: number;
    deduplicatedTokens?: number;
    candidateFiles?: number;
    returnedFiles?: number;
    createdAt?: number;
}

export interface ModelUsage {
    id?: string;
    taskId?: string;
    sessionId?: string;
    agentId?: string;
    provider?: string;
    model?: string;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
    cacheWriteTokens?: number;
    observedCostUsd?: number;
    source: string;
    createdAt?: number;
}

export interface ContextCacheRecord {
    cacheKey: string;
    cacheType: 'static' | 'component' | 'semantic' | 'checkpoint';
    repo: string;
    branch: string;
    commitSha?: string;
    dependencyFingerprint: string;
    payloadJson: string;
    payloadTokens: number;
    hitCount?: number;
    createdAt?: number;
    lastHitAt?: number;
}

export interface CheckpointMetric {
    checkpointId: string;
    taskId: string;
    agentId: string;
    rawStateTokens: number;
    checkpointTokens: number;
    replayTokensAvoided: number;
    createdAt?: number;
}

// Fallback JSON persistence path if SQLite is unavailable
function getFallbackDir(cwd?: string): string {
    return path.join(cwd || process.cwd(), '.rigour');
}

/**
 * Log a context retrieval event.
 */
export async function recordContextEvent(event: ContextEvent, cwd?: string): Promise<string> {
    const id = event.id || `evt-${randomUUID()}`;
    const timestamp = event.createdAt || Date.now();
    const candidateTokens = event.candidateTokens || 0;
    const returnedTokens = event.returnedTokens || 0;
    const deduplicatedTokens = event.deduplicatedTokens || 0;
    const candidateFiles = event.candidateFiles || 0;
    const returnedFiles = event.returnedFiles || 0;

    if (isSQLiteAvailable()) {
        try {
            const db = await openDatabase();
            if (db) {
                await db.run(
                    `INSERT INTO context_events (
                        id, task_id, session_id, agent_id, tool_name, query_hash, cache_status,
                        candidate_tokens, returned_tokens, deduplicated_tokens, candidate_files, returned_files, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    id,
                    event.taskId || null,
                    event.sessionId || null,
                    event.agentId || null,
                    event.toolName,
                    event.queryHash || null,
                    event.cacheStatus,
                    candidateTokens,
                    returnedTokens,
                    deduplicatedTokens,
                    candidateFiles,
                    returnedFiles,
                    timestamp
                );
                await db.close();
                return id;
            }
        } catch {
            // fallback to JSON
        }
    }

    const fallbackDir = getFallbackDir(cwd);
    const fallbackPath = path.join(fallbackDir, 'context-events.jsonl');
    await fs.ensureDir(fallbackDir);
    const record = { ...event, id, createdAt: timestamp };
    await fs.appendFile(fallbackPath, JSON.stringify(record) + '\n');
    return id;
}

/**
 * Log observed model usage (Cursor Admin API, CSV import, or manual).
 */
export async function recordModelUsage(usage: ModelUsage, cwd?: string): Promise<string> {
    const id = usage.id || `usage-${randomUUID()}`;
    const timestamp = usage.createdAt || Date.now();

    if (isSQLiteAvailable()) {
        try {
            const db = await openDatabase();
            if (db) {
                await db.run(
                    `INSERT INTO model_usage (
                        id, task_id, session_id, agent_id, provider, model,
                        input_tokens, output_tokens, cached_input_tokens, observed_cost_usd, source, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    id,
                    usage.taskId || null,
                    usage.sessionId || null,
                    usage.agentId || null,
                    usage.provider || 'cursor',
                    usage.model || 'claude-3-5-sonnet',
                    usage.inputTokens,
                    usage.outputTokens,
                    usage.cachedInputTokens || 0,
                    usage.observedCostUsd || 0,
                    usage.source,
                    timestamp
                );
                await db.close();
                return id;
            }
        } catch {
            // fallback to JSON
        }
    }

    const fallbackDir = getFallbackDir(cwd);
    const fallbackPath = path.join(fallbackDir, 'model-usage.jsonl');
    await fs.ensureDir(fallbackDir);
    const record = { ...usage, id, createdAt: timestamp };
    await fs.appendFile(fallbackPath, JSON.stringify(record) + '\n');
    return id;
}

/**
 * Insert or update cache entry.
 */
export async function setContextCacheRecord(record: ContextCacheRecord, cwd?: string): Promise<void> {
    const timestamp = record.createdAt || Date.now();

    if (isSQLiteAvailable()) {
        try {
            const db = await openDatabase();
            if (db) {
                await db.run(
                    `INSERT INTO context_cache (
                        cache_key, cache_type, repo, branch, commit_sha, dependency_fingerprint,
                        payload_json, payload_tokens, hit_count, created_at, last_hit_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(cache_key) DO UPDATE SET
                        dependency_fingerprint=excluded.dependency_fingerprint,
                        payload_json=excluded.payload_json,
                        payload_tokens=excluded.payload_tokens,
                        created_at=excluded.created_at`,
                    record.cacheKey,
                    record.cacheType,
                    record.repo,
                    record.branch,
                    record.commitSha || null,
                    record.dependencyFingerprint,
                    record.payloadJson,
                    record.payloadTokens,
                    record.hitCount || 0,
                    timestamp,
                    record.lastHitAt || null
                );
                await db.close();
                return;
            }
        } catch {
            // fallback
        }
    }

    const fallbackDir = getFallbackDir(cwd);
    const fallbackPath = path.join(fallbackDir, 'context-cache.json');
    await fs.ensureDir(fallbackDir);
    let cacheData: Record<string, ContextCacheRecord> = {};
    if (await fs.pathExists(fallbackPath)) {
        try {
            cacheData = await fs.readJson(fallbackPath);
        } catch {}
    }
    cacheData[record.cacheKey] = { ...record, createdAt: timestamp };
    await fs.writeJson(fallbackPath, cacheData, { spaces: 2 });
}

/**
 * Fetch cached context record by cache key. Increments hit count.
 */
export async function getContextCacheRecord(cacheKey: string, cwd?: string): Promise<ContextCacheRecord | null> {
    if (isSQLiteAvailable()) {
        try {
            const db = await openDatabase();
            if (db) {
                const row = await db.get(`SELECT * FROM context_cache WHERE cache_key = ?`, cacheKey);
                if (row) {
                    const now = Date.now();
                    await db.run(`UPDATE context_cache SET hit_count = hit_count + 1, last_hit_at = ? WHERE cache_key = ?`, now, cacheKey);
                    await db.close();
                    return {
                        cacheKey: row.cache_key,
                        cacheType: row.cache_type,
                        repo: row.repo,
                        branch: row.branch,
                        commitSha: row.commit_sha,
                        dependencyFingerprint: row.dependency_fingerprint,
                        payloadJson: row.payload_json,
                        payloadTokens: row.payload_tokens,
                        hitCount: (row.hit_count || 0) + 1,
                        createdAt: row.created_at,
                        lastHitAt: now
                    };
                }
                await db.close();
                return null;
            }
        } catch {
            // fallback
        }
    }

    const fallbackPath = path.join(getFallbackDir(cwd), 'context-cache.json');
    if (await fs.pathExists(fallbackPath)) {
        try {
            const cacheData = await fs.readJson(fallbackPath);
            const entry = cacheData[cacheKey];
            if (entry) {
                entry.hitCount = (entry.hitCount || 0) + 1;
                entry.lastHitAt = Date.now();
                await fs.writeJson(fallbackPath, cacheData, { spaces: 2 });
                return entry;
            }
        } catch {}
    }
    return null;
}

/**
 * Record subagent checkpoint metrics.
 */
export async function recordCheckpointMetric(metric: CheckpointMetric, cwd?: string): Promise<void> {
    const timestamp = metric.createdAt || Date.now();

    if (isSQLiteAvailable()) {
        try {
            const db = await openDatabase();
            if (db) {
                await db.run(
                    `INSERT INTO checkpoint_metrics (
                        checkpoint_id, task_id, agent_id, raw_state_tokens, checkpoint_tokens, replay_tokens_avoided, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(checkpoint_id) DO UPDATE SET
                        raw_state_tokens=excluded.raw_state_tokens,
                        checkpoint_tokens=excluded.checkpoint_tokens,
                        replay_tokens_avoided=excluded.replay_tokens_avoided`,
                    metric.checkpointId,
                    metric.taskId,
                    metric.agentId,
                    metric.rawStateTokens,
                    metric.checkpointTokens,
                    metric.replayTokensAvoided,
                    timestamp
                );
                await db.close();
                return;
            }
        } catch {
            // fallback
        }
    }

    const fallbackDir = getFallbackDir(cwd);
    const fallbackPath = path.join(fallbackDir, 'checkpoint-metrics.jsonl');
    await fs.ensureDir(fallbackDir);
    await fs.appendFile(fallbackPath, JSON.stringify({ ...metric, createdAt: timestamp }) + '\n');
}

/**
 * Helper to fetch all recorded context events.
 */
export async function getContextEvents(taskId?: string, cwd?: string): Promise<ContextEvent[]> {
    if (isSQLiteAvailable()) {
        try {
            const db = await openDatabase();
            if (db) {
                const query = taskId
                    ? `SELECT * FROM context_events WHERE task_id = ? ORDER BY created_at DESC`
                    : `SELECT * FROM context_events ORDER BY created_at DESC`;
                const params = taskId ? [taskId] : [];
                const rows = await db.all(query, ...params);
                await db.close();
                return rows.map((r: any) => ({
                    id: r.id,
                    taskId: r.task_id,
                    sessionId: r.session_id,
                    agentId: r.agent_id,
                    toolName: r.tool_name,
                    queryHash: r.query_hash,
                    cacheStatus: r.cache_status,
                    candidateTokens: r.candidate_tokens,
                    returnedTokens: r.returned_tokens,
                    deduplicatedTokens: r.deduplicated_tokens,
                    candidateFiles: r.candidate_files,
                    returnedFiles: r.returned_files,
                    createdAt: r.created_at
                }));
            }
        } catch {
            // fallback
        }
    }

    const fallbackPath = path.join(getFallbackDir(cwd), 'context-events.jsonl');
    if (!await fs.pathExists(fallbackPath)) return [];
    const lines = (await fs.readFile(fallbackPath, 'utf8')).split('\n').filter(Boolean);
    const events: ContextEvent[] = lines.map(l => JSON.parse(l));
    return taskId ? events.filter(e => e.taskId === taskId) : events;
}

/**
 * Helper to fetch model usage records.
 */
export async function getModelUsages(taskId?: string, cwd?: string): Promise<ModelUsage[]> {
    if (isSQLiteAvailable()) {
        try {
            const db = await openDatabase();
            if (db) {
                const query = taskId
                    ? `SELECT * FROM model_usage WHERE task_id = ? ORDER BY created_at DESC`
                    : `SELECT * FROM model_usage ORDER BY created_at DESC`;
                const params = taskId ? [taskId] : [];
                const rows = await db.all(query, ...params);
                await db.close();
                return rows.map((r: any) => ({
                    id: r.id,
                    taskId: r.task_id,
                    sessionId: r.session_id,
                    agentId: r.agent_id,
                    provider: r.provider,
                    model: r.model,
                    inputTokens: r.input_tokens,
                    outputTokens: r.output_tokens,
                    cachedInputTokens: r.cached_input_tokens,
                    observedCostUsd: r.observed_cost_usd,
                    source: r.source,
                    createdAt: r.created_at
                }));
            }
        } catch {
            // fallback
        }
    }

    const fallbackPath = path.join(getFallbackDir(cwd), 'model-usage.jsonl');
    if (!await fs.pathExists(fallbackPath)) return [];
    const lines = (await fs.readFile(fallbackPath, 'utf8')).split('\n').filter(Boolean);
    const usages: ModelUsage[] = lines.map(l => JSON.parse(l));
    return taskId ? usages.filter(u => u.taskId === taskId) : usages;
}

/**
 * Helper to fetch checkpoint metrics.
 */
export async function getCheckpointMetrics(taskId?: string, cwd?: string): Promise<CheckpointMetric[]> {
    if (isSQLiteAvailable()) {
        try {
            const db = await openDatabase();
            if (db) {
                const query = taskId
                    ? `SELECT * FROM checkpoint_metrics WHERE task_id = ? ORDER BY created_at DESC`
                    : `SELECT * FROM checkpoint_metrics ORDER BY created_at DESC`;
                const params = taskId ? [taskId] : [];
                const rows = await db.all(query, ...params);
                await db.close();
                return rows.map((r: any) => ({
                    checkpointId: r.checkpoint_id,
                    taskId: r.task_id,
                    agentId: r.agent_id,
                    rawStateTokens: r.raw_state_tokens,
                    checkpointTokens: r.checkpoint_tokens,
                    replayTokensAvoided: r.replay_tokens_avoided,
                    createdAt: r.created_at
                }));
            }
        } catch {
            // fallback
        }
    }

    const fallbackPath = path.join(getFallbackDir(cwd), 'checkpoint-metrics.jsonl');
    if (!await fs.pathExists(fallbackPath)) return [];
    const lines = (await fs.readFile(fallbackPath, 'utf8')).split('\n').filter(Boolean);
    const metrics: CheckpointMetric[] = lines.map(l => JSON.parse(l));
    return taskId ? metrics.filter(m => m.taskId === taskId) : metrics;
}
