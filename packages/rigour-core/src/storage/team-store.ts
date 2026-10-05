import { spawnSync } from 'child_process';
import fs from 'fs-extra';
import path from 'path';
import { openDatabase } from './db.js';
import { decryptLocalPayload, encryptLocalPayload } from './local-encryption.js';
import { TEAM_SCHEMA } from './team-schema.js';
import { diagnoseMissingMembership, explainTeamConnectionError } from './team-diagnostics.js';
import { rigourUserDir } from '../utils/user-state.js';
import { withheldReason } from './team-scope.js';
import {
    TEAM_VECTOR_SCHEMA,
    backfillConfiguredTeamEmbeddings,
    getTeamSemanticHealth,
    searchConfiguredTeamKnowledge,
    upsertTeamLessonEmbedding,
} from './team-vector-store.js';

export interface TeamConfiguration {
    organizationId: string;
    teamId: string;
    actorId: string;
    databaseUrl?: string;
    semantic?: TeamSemanticConfiguration;
    /** The team's repositories (`github.com/acme/*`); lessons from any other repository stay local. */
    repositories?: string[];
    /** Also send lessons marked personal (default false). */
    syncPersonal?: boolean;
}

export interface TeamSemanticConfiguration {
    provider: 'pgvector';
    model: 'Xenova/all-MiniLM-L6-v2';
    dimensions: 384;
}

export interface TeamModeStatus {
    mode: 'local' | 'team';
    connectivity: 'local' | 'online' | 'offline';
    organizationId?: string;
    teamId?: string;
    actorId?: string;
    queuedChanges: number;
    message: string;
    semantic?: {
        provider: 'pgvector';
        status: 'ready' | 'degraded';
        extensionVersion?: string;
        model: string;
        dimensions: number;
        indexedLessons?: number;
        missingLessons?: number;
        message?: string;
    };
}

export interface TeamDoctorResult extends TeamModeStatus {
    schemaVersion?: number;
    databaseRole?: string;
    permissions?: string[];
}

export interface SemanticKnowledgeCandidate {
    lessonId: string;
    repositoryId: string;
    subject: string;
    visibility: string;
    state: string;
    confidence: number;
    similarity: number;
    provenance: string;
}

export interface SemanticKnowledgeResult {
    status: 'disabled' | 'ready' | 'degraded';
    provider?: 'pgvector';
    model?: string;
    candidates: SemanticKnowledgeCandidate[];
    message?: string;
}

const DEFAULT_SEMANTIC: TeamSemanticConfiguration = {
    provider: 'pgvector',
    model: 'Xenova/all-MiniLM-L6-v2',
    dimensions: 384,
};

export const TEAM_CONFIG_PATH = path.join(rigourUserDir(), 'team.json');

function nonEmpty(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function validateTeamDatabaseUrl(databaseUrl: string): void {
    const parsed = new URL(databaseUrl);
    if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
        throw new Error('Team database URL must use postgres:// or postgresql://.');
    }
    const local = ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname);
    const sslMode = parsed.searchParams.get('sslmode');
    if (!local && sslMode !== 'require' && sslMode !== 'verify-full') {
        throw new Error('Remote team databases require sslmode=require or sslmode=verify-full.');
    }
}

export async function loadTeamConfiguration(): Promise<TeamConfiguration | null> {
    let file: Partial<TeamConfiguration> = {};
    try {
        file = await fs.readJson(TEAM_CONFIG_PATH);
    } catch {
        // Environment-only configuration is supported.
    }
    const organizationId = nonEmpty(process.env.RIGOUR_ORGANIZATION_ID) ?? nonEmpty(file.organizationId);
    const teamId = nonEmpty(process.env.RIGOUR_TEAM_ID) ?? nonEmpty(file.teamId);
    const actorId = nonEmpty(process.env.RIGOUR_ACTOR_ID) ?? nonEmpty(file.actorId);
    const databaseUrl = nonEmpty(process.env.RIGOUR_TEAM_DATABASE_URL) ?? databaseUrlFromCommand() ?? nonEmpty(file.databaseUrl);
    if (!organizationId || !teamId || !actorId || !databaseUrl) return null;
    const envSemantic = process.env.RIGOUR_TEAM_SEMANTIC === 'pgvector' ? DEFAULT_SEMANTIC : undefined;
    const semantic = envSemantic ?? (file.semantic?.provider === 'pgvector' ? DEFAULT_SEMANTIC : undefined);
    const envRepositories = nonEmpty(process.env.RIGOUR_TEAM_REPOSITORIES)?.split(',').map(r => r.trim()).filter(Boolean);
    const repositories = envRepositories ?? (Array.isArray(file.repositories) ? file.repositories.filter(r => typeof r === 'string') : undefined);
    const syncPersonal = process.env.RIGOUR_TEAM_SYNC_PERSONAL !== undefined ? process.env.RIGOUR_TEAM_SYNC_PERSONAL === '1' : file.syncPersonal === true;
    return { organizationId, teamId, actorId, databaseUrl, semantic, repositories, syncPersonal };
}

let commandUrl: string | null | undefined;

/** A profile's `databaseUrlCommand` (RIGOUR_TEAM_DATABASE_URL_COMMAND): run once per process, its output never stored. */
function databaseUrlFromCommand(): string | undefined {
    const command = nonEmpty(process.env.RIGOUR_TEAM_DATABASE_URL_COMMAND);
    if (!command) return undefined;
    if (commandUrl === undefined) {
        const result = spawnSync(command, { shell: true, encoding: 'utf8', timeout: 15_000 });
        commandUrl = result.status === 0 ? nonEmpty(result.stdout) ?? null : null;
    }
    return commandUrl ?? undefined;
}

export async function saveTeamConfiguration(config: TeamConfiguration): Promise<void> {
    if (!config.databaseUrl) throw new Error('A PostgreSQL database URL is required.');
    validateTeamDatabaseUrl(config.databaseUrl);
    for (const [name, value] of Object.entries({
        organizationId: config.organizationId,
        teamId: config.teamId,
        actorId: config.actorId,
    })) {
        if (!nonEmpty(value)) throw new Error(`${name} is required.`);
    }
    await fs.ensureDir(path.dirname(TEAM_CONFIG_PATH));
    await fs.writeJson(TEAM_CONFIG_PATH, config, { spaces: 2, mode: 0o600 });
    await fs.chmod(TEAM_CONFIG_PATH, 0o600);
}

async function loadPg(): Promise<{ Pool: new (options: { connectionString: string }) => any }> {
    try {
        return await import('pg') as unknown as { Pool: new (options: { connectionString: string }) => any };
    } catch {
        throw new Error('PostgreSQL support is unavailable. Install the optional "pg" dependency.');
    }
}

async function queuedChanges(): Promise<number> {
    let db;
    try { db = await openDatabase(); } catch { return 0; }
    if (!db) return 0;
    try {
        const row = await db.get('SELECT COUNT(*) AS count FROM sync_outbox WHERE synced_at IS NULL');
        return Number(row?.count ?? 0);
    } finally {
        await db.close();
    }
}

export async function initializeTeamSchema(databaseUrl: string, options: { pgvector?: boolean } = {}): Promise<void> {
    validateTeamDatabaseUrl(databaseUrl);
    const { Pool } = await loadPg();
    const pool = new Pool({ connectionString: databaseUrl });
    try {
        await pool.query(TEAM_SCHEMA);
        if (options.pgvector) await pool.query(TEAM_VECTOR_SCHEMA);
    } finally {
        await pool.end();
    }
}

export async function getTeamModeStatus(): Promise<TeamModeStatus> {
    const config = await loadTeamConfiguration();
    const queued = await queuedChanges();
    if (!config?.databaseUrl) {
        return { mode: 'local', connectivity: 'local', queuedChanges: queued, message: 'SQLite local-only mode' };
    }
    try {
        const result = await doctorTeamConnection(config);
        return result.connectivity === 'offline' ? { ...result, message: `Offline — changes queued. ${result.message}` } : result;
    } catch (error) {
        return {
            mode: 'team',
            connectivity: 'offline',
            organizationId: config.organizationId,
            teamId: config.teamId,
            actorId: config.actorId,
            queuedChanges: queued,
            message: `Offline — changes queued. ${error instanceof Error ? error.message : String(error)}`,
        };
    }
}

export async function doctorTeamConnection(config?: TeamConfiguration): Promise<TeamDoctorResult> {
    const resolved = config ?? await loadTeamConfiguration();
    if (!resolved?.databaseUrl) {
        return { mode: 'local', connectivity: 'local', queuedChanges: await queuedChanges(), message: 'Team mode is not configured.' };
    }
    const offline = async (message: string): Promise<TeamDoctorResult> => ({
        mode: 'team',
        connectivity: 'offline',
        organizationId: resolved.organizationId,
        teamId: resolved.teamId,
        actorId: resolved.actorId,
        queuedChanges: await queuedChanges(),
        message,
    });
    try {
        validateTeamDatabaseUrl(resolved.databaseUrl);
    } catch (error) {
        return offline(explainTeamConnectionError(error));
    }
    const { Pool } = await loadPg();
    const pool = new Pool({ connectionString: resolved.databaseUrl });
    try {
        const result = await pool.query(
            `SELECT current_user AS database_role,
                    (SELECT value::integer FROM rigour.meta WHERE key = 'schema_version') AS schema_version,
                    role
             FROM rigour.memberships
             WHERE db_role = current_user AND team_id = $1 AND actor_id = $2 AND organization_id = $3`,
            [resolved.teamId, resolved.actorId, resolved.organizationId],
        );
        if (result.rowCount !== 1) return offline(await diagnoseMissingMembership(pool));
        const schemaVersion = Number(result.rows[0].schema_version);
        if (schemaVersion !== 1) return offline(`Incompatible team schema version ${schemaVersion}; expected 1.`);
        const semantic = resolved.semantic ? await getTeamSemanticHealth(pool, resolved) : undefined;
        return {
            mode: 'team',
            connectivity: 'online',
            organizationId: resolved.organizationId,
            teamId: resolved.teamId,
            actorId: resolved.actorId,
            queuedChanges: await queuedChanges(),
            schemaVersion,
            databaseRole: String(result.rows[0].database_role),
            permissions: [String(result.rows[0].role)],
            semantic,
            message: 'PostgreSQL team mode is healthy.',
        };
    } catch (error) {
        return offline(explainTeamConnectionError(error));
    } finally {
        await pool.end().catch(() => undefined);
    }
}

/** Queued items split into those this team may receive and those that stay on this machine, with why. */
async function splitOutbox(db: { get(sql: string, ...params: unknown[]): Promise<any> }, queued: any[], config: TeamConfiguration) {
    const sendable: Array<{ item: any; lesson: any }> = [];
    const held: Array<{ id: string; reason: string }> = [];
    for (const item of queued) {
        const lesson = await decryptLocalPayload<any>(item.payload_json);
        const repo = await db.get('SELECT canonical_uri FROM repositories WHERE id = ?', lesson.repositoryId);
        const reason = withheldReason(lesson.visibility, repo?.canonical_uri, config);
        if (reason) held.push({ id: item.id, reason });
        else sendable.push({ item, lesson });
    }
    return { sendable, held };
}

export async function syncTeamOutbox(options: { dryRun?: boolean } = {}): Promise<{ pending: number; withheld: number; synced: number; pulled: number }> {
    const config = await loadTeamConfiguration();
    if (!config?.databaseUrl) throw new Error('Team mode is not configured.');
    const db = await openDatabase();
    if (!db) throw new Error('SQLite offline cache is unavailable.');
    try {
        const queued = await db.all(
            `SELECT * FROM sync_outbox WHERE synced_at IS NULL ORDER BY created_at ASC LIMIT 200`,
        );
        const { sendable: pending, held } = await splitOutbox(db, queued, config);
        if (options.dryRun) return { pending: pending.length, withheld: held.length, synced: 0, pulled: 0 };
        for (const item of held) {
            await db.run('UPDATE sync_outbox SET synced_at = ?, last_error = ? WHERE id = ?', Date.now(), `not sent: ${item.reason}`, item.id);
        }

        const { Pool } = await loadPg();
        const pool = new Pool({ connectionString: config.databaseUrl });
        let synced = 0;
        let pulled = 0;
        try {
            const membership = await pool.query(
                `SELECT 1 FROM rigour.memberships
                  WHERE db_role = current_user AND team_id = $1
                    AND actor_id = $2 AND organization_id = $3`,
                [config.teamId, config.actorId, config.organizationId],
            );
            if (membership.rowCount !== 1) throw new Error(await diagnoseMissingMembership(pool));
            for (const { item, lesson } of pending) {
                try {
                    const result = await pool.query(
                        `INSERT INTO rigour.lessons (
                        id, organization_id, team_id, repository_id, actor_id, visibility, state,
                        kind, subject, evidence_json, confidence, source, supersedes_id, created_at, updated_at
                    )
                    SELECT $1, membership.organization_id, membership.team_id, $2, membership.actor_id,
                           $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12
                    FROM rigour.memberships membership
                    WHERE membership.db_role = current_user AND membership.team_id = $13
                      AND membership.actor_id = $14 AND membership.organization_id = $15
                    ON CONFLICT (id) DO UPDATE SET
                        visibility = EXCLUDED.visibility,
                        state = EXCLUDED.state,
                        evidence_json = EXCLUDED.evidence_json,
                        confidence = EXCLUDED.confidence,
                        updated_at = EXCLUDED.updated_at
                    WHERE rigour.lessons.updated_at <= EXCLUDED.updated_at
                    RETURNING id`,
                        [
                            lesson.id, lesson.repositoryId, lesson.visibility, lesson.state, lesson.kind,
                            lesson.subject, JSON.stringify(lesson.evidence), lesson.confidence, lesson.source,
                            lesson.supersedesId ?? null, lesson.createdAt, lesson.updatedAt, config.teamId,
                            config.actorId, config.organizationId,
                        ],
                    );
                    if (config.semantic && result.rowCount > 0) await upsertTeamLessonEmbedding(pool, config, lesson);
                    await db.run('UPDATE sync_outbox SET synced_at = ?, last_error = NULL WHERE id = ?', Date.now(), item.id);
                    synced++;
                } catch (error) {
                    await db.run(
                        'UPDATE sync_outbox SET attempts = attempts + 1, last_error = ? WHERE id = ?',
                        String(error instanceof Error ? error.message : error).slice(0, 1_000), item.id,
                    );
                    throw error;
                }
            }
            const remote = await pool.query(
                `SELECT * FROM rigour.lessons
                 WHERE team_id = $1 AND organization_id = $3
                   AND ((actor_id = $2) OR (visibility = 'team' AND state = 'promoted'))
                 ORDER BY updated_at ASC`,
                [config.teamId, config.actorId, config.organizationId],
            );
            for (const row of remote.rows) {
                const evidence = typeof row.evidence_json === 'string' ? JSON.parse(row.evidence_json) : row.evidence_json;
                await db.run(
                    `INSERT INTO lessons (
                        id, repository_id, actor_id, team_id, visibility, state, kind, subject,
                        evidence_json, confidence, source, supersedes_id, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(id) DO UPDATE SET
                        visibility=excluded.visibility, state=excluded.state, evidence_json=excluded.evidence_json,
                        confidence=excluded.confidence, source=excluded.source, supersedes_id=excluded.supersedes_id,
                        updated_at=excluded.updated_at`,
                    row.id, row.repository_id, row.actor_id, row.team_id, row.visibility, row.state,
                    row.kind, row.subject, await encryptLocalPayload(evidence), row.confidence, row.source,
                    row.supersedes_id, Number(row.created_at), Number(row.updated_at),
                );
                pulled++;
            }
            if (pulled > 0) await db.run("DELETE FROM context_cache WHERE cache_type = 'semantic'");
        } finally {
            await pool.end();
        }
        return { pending: pending.length, withheld: held.length, synced, pulled };
    } finally {
        await db.close();
    }
}

export async function backfillTeamEmbeddings(limit = 200): Promise<{ eligible: number; embedded: number; skipped: number }> {
    const config = await loadTeamConfiguration();
    if (!config) throw new Error('pgvector team semantics is not configured.');
    return backfillConfiguredTeamEmbeddings(config, limit);
}

export async function searchTeamKnowledge(query: string, limit = 8): Promise<SemanticKnowledgeResult> {
    const config = await loadTeamConfiguration();
    if (!config) return { status: 'disabled', candidates: [] };
    return searchConfiguredTeamKnowledge(config, query, limit);
}
