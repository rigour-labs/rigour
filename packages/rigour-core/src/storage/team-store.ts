import { spawnSync } from 'child_process';
import fs from 'fs-extra';
import path from 'path';
import { openDatabase } from './db.js';
import { encryptLocalPayload } from './local-encryption.js';
import { TEAM_SCHEMA } from './team-schema.js';
import { TEAM_SCHEMA_UPGRADE, readMembershipAccess, recordTeamAccess, sentActorOf, widensAccess } from './team-access.js';
import { diagnoseMissingMembership, explainSyncError, explainTeamConnectionError, missingReviewDecisionGrants, refusedRow, TABLE_GRANTS } from './team-diagnostics.js';
import { rigourUserDir } from '../utils/user-state.js';
import { addToTeamList } from './team-scope.js';
import { markNotSent, outboxCounts, queuedChanges, QUEUED, SEND_BATCH, splitOutbox } from './team-outbox.js';
import { getRepositoryId, originOf } from './repository-origin.js';
import { previewReviewDecisions, syncReviewDecisions, type DecisionPreview, type DecisionSync } from './team-review-decisions.js';
import { personOf } from '../utils/person.js';
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
    /** Whether the database can hold shared review decisions: `missing` until the administrator runs init-schema again. */
    /** `missing grant`: the tables are there, but this login cannot use them; the message has the GRANT to run. */
    reviewDecisions?: 'ready' | 'missing' | 'missing grant';
    /** Whether an sme or owner sees and decides on every member's team candidates: `missing` until an owner runs init-schema again. */
    candidateReview?: 'ready' | 'missing';
    /** Whether a member may propose team candidates of their own: `missing` until an owner runs init-schema again. */
    memberCandidates?: 'ready' | 'missing';
    databaseRole?: string;
    permissions?: string[];
    /** The repository doctor runs in, when it has an origin remote: whether the team lists it, and what adds it when not. */
    repository?: { listed: boolean; warning?: string };
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

async function readTeamFile(): Promise<Partial<TeamConfiguration>> {
    try {
        return await fs.readJson(TEAM_CONFIG_PATH);
    } catch {
        return {}; // Environment-only configuration is supported.
    }
}

/**
 * The settings team mode still needs when some are given (in the environment or team.json) but not all, each named
 * as its environment variable; empty when none is given (team mode simply isn't in use) or all are.
 */
async function missingTeamSettings(): Promise<string[]> {
    const file = await readTeamFile();
    const settings: Array<[string, boolean]> = [
        ['RIGOUR_TEAM_DATABASE_URL', Boolean(nonEmpty(process.env.RIGOUR_TEAM_DATABASE_URL) ?? nonEmpty(process.env.RIGOUR_TEAM_DATABASE_URL_COMMAND) ?? nonEmpty(file.databaseUrl))],
        ['RIGOUR_ORGANIZATION_ID', Boolean(nonEmpty(process.env.RIGOUR_ORGANIZATION_ID) ?? nonEmpty(file.organizationId))],
        ['RIGOUR_TEAM_ID', Boolean(nonEmpty(process.env.RIGOUR_TEAM_ID) ?? nonEmpty(file.teamId))],
        ['RIGOUR_ACTOR_ID', Boolean(nonEmpty(process.env.RIGOUR_ACTOR_ID) ?? nonEmpty(file.actorId))],
    ];
    if (!settings.some(([, given]) => given)) return [];
    return settings.filter(([, given]) => !given).map(([name]) => name);
}

/** Said when team mode is off: which settings are missing, when some were given. */
async function notConfigured(): Promise<string> {
    const missing = await missingTeamSettings();
    return missing.length
        ? `Team mode is not configured: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} missing (set ${missing.length === 1 ? 'it' : 'them'} in the environment, or run rigour team configure).`
        : 'Team mode is not configured.';
}

export async function loadTeamConfiguration(): Promise<TeamConfiguration | null> {
    const file = await readTeamFile();
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

async function loadPg(): Promise<{ Pool: new (options: import('pg').PoolConfig) => any }> {
    try {
        return await import('pg') as unknown as { Pool: new (options: import('pg').PoolConfig) => any };
    } catch {
        throw new Error('PostgreSQL support is unavailable. Install the optional "pg" dependency.');
    }
}


/** What init-schema granted, to whom, and the GRANTs it could not run itself (its login is not the tables' owner). */
export interface SchemaGrants {
    granted: Array<{ role: string; statements: string[] }>;
    manual: string[];
}

export async function initializeTeamSchema(databaseUrl: string, options: { pgvector?: boolean } = {}): Promise<SchemaGrants> {
    validateTeamDatabaseUrl(databaseUrl);
    const { Pool } = await loadPg();
    const pool = new Pool({ connectionString: databaseUrl });
    try {
        await pool.query(TEAM_SCHEMA);
        if (options.pgvector) await pool.query(TEAM_VECTOR_SCHEMA);
        return await grantMembers(pool);
    } finally {
        await pool.end();
    }
}

/**
 * Every member login the schema knows (rigour.memberships) gets what a sync needs on every team table there is, as the
 * guide grants it: a table this version adds is usable at once, with no GRANT left for doctor to find. A GRANT this
 * login may not run is returned for the administrator instead.
 */
async function grantMembers(pool: { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }): Promise<SchemaGrants> {
    const roles = (await pool.query('SELECT DISTINCT db_role::text AS role FROM rigour.memberships ORDER BY 1')).rows.map(row => String(row.role));
    const tables = Object.keys(TABLE_GRANTS);
    const present = new Set((await pool.query(`SELECT name FROM unnest($1::text[]) AS name WHERE to_regclass('rigour.' || name) IS NOT NULL`, [tables])).rows.map(row => String(row.name)));
    const result: SchemaGrants = { granted: [], manual: [] };
    for (const role of roles) {
        const quoted = `"${role.replace(/"/g, '""')}"`;
        const statements = [`GRANT USAGE ON SCHEMA rigour TO ${quoted};`, ...tables.filter(table => present.has(table)).map(table => `GRANT ${TABLE_GRANTS[table]} ON rigour.${table} TO ${quoted};`)];
        const done: string[] = [];
        for (const statement of statements) {
            try {
                await pool.query(statement);
                done.push(statement);
            } catch (error) {
                if ((error as { code?: unknown })?.code !== '42501') throw error; // insufficient_privilege: the administrator's to run
                result.manual.push(statement);
            }
        }
        if (done.length) result.granted.push({ role, statements: done });
    }
    return result;
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

/** Whether the repository at `cwd` is in the team's list; undefined without a `cwd` or an origin remote. */
async function repositoryInTeam(cwd: string | undefined, config: TeamConfiguration): Promise<TeamDoctorResult['repository']> {
    const origin = cwd && await originOf(cwd);
    if (!origin) return undefined;
    const add = addToTeamList(origin, config);
    return add
        ? { listed: false, warning: `This repository is not in the team's repositories: team memories and lessons saved here are kept as team candidates on this machine and sent once it is: ${add}` }
        : { listed: true };
}

/** With `cwd`, also checks that the repository there is in the team's list. */
export async function doctorTeamConnection(config?: TeamConfiguration, cwd?: string): Promise<TeamDoctorResult> {
    const resolved = config ?? await loadTeamConfiguration();
    if (!resolved?.databaseUrl) {
        return { mode: 'local', connectivity: 'local', queuedChanges: await queuedChanges(), message: await notConfigured() };
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
                    (SELECT value::integer FROM rigour.meta WHERE key = 'review_decisions_version') AS review_decisions_version,
                    (SELECT value FROM rigour.meta WHERE key = 'candidate_review_version') AS candidate_review_version,
                    (SELECT value FROM rigour.meta WHERE key = 'member_candidates_version') AS member_candidates_version,
                    role
             FROM rigour.memberships
             WHERE db_role = current_user AND team_id = $1 AND actor_id = $2 AND organization_id = $3`,
            [resolved.teamId, resolved.actorId, resolved.organizationId],
        );
        if (result.rowCount !== 1) return offline(await diagnoseMissingMembership(pool));
        const schemaVersion = Number(result.rows[0].schema_version);
        if (schemaVersion !== 1) return offline(`Incompatible team schema version ${schemaVersion}; expected 1.`);
        const semantic = resolved.semantic ? await getTeamSemanticHealth(pool, resolved) : undefined;
        const role = String(result.rows[0].role);
        const tables = Number(result.rows[0].review_decisions_version) === 1;
        const missingGrant = tables ? await missingReviewDecisionGrants(pool, String(result.rows[0].database_role), role) : undefined;
        const reviewDecisions = !tables ? 'missing' : missingGrant ? 'missing grant' : 'ready';
        const candidateReview = result.rows[0].candidate_review_version === '1' ? 'ready' : 'missing';
        const memberCandidates = result.rows[0].member_candidates_version === '1' ? 'ready' : 'missing';
        return {
            mode: 'team',
            connectivity: 'online',
            organizationId: resolved.organizationId,
            teamId: resolved.teamId,
            actorId: resolved.actorId,
            queuedChanges: await queuedChanges(),
            schemaVersion,
            databaseRole: String(result.rows[0].database_role),
            permissions: [role],
            semantic,
            reviewDecisions,
            candidateReview,
            memberCandidates,
            repository: await repositoryInTeam(cwd, resolved),
            message: doctorMessage(reviewDecisions, missingGrant, candidateReview === 'ready' && memberCandidates === 'ready'),
        };
    } catch (error) {
        return offline(explainTeamConnectionError(error));
    } finally {
        await pool.end().catch(() => undefined);
    }
}

/** Doctor's one line for a database it reached: review decisions' state, and what holds while the candidate rules are missing. */
function doctorMessage(reviewDecisions: TeamDoctorResult['reviewDecisions'], missingGrant: string | undefined, candidateRules: boolean): string {
    const message = reviewDecisions === 'ready'
        ? 'PostgreSQL team mode is healthy. A clone receives the team\'s decisions on review lessons at its first sync (`rigour team sync`, or the next Rigour tool call).'
        : reviewDecisions === 'missing grant'
            ? `PostgreSQL team mode is healthy for lessons, but review decisions are not: ${missingGrant}`
            : 'PostgreSQL team mode is healthy. Review decisions are not shared yet: the administrator runs `rigour team init-schema` again to add them.';
    return candidateRules ? message : `${message} ${TEAM_SCHEMA_UPGRADE}`;
}

/** How far before the last pull a sync reads again, for members whose clocks run behind. */
const PULL_OVERLAP_MS = 15 * 60_000;


/**
 * `held`: lessons kept queued because their repository is not in the team's list yet (`heldBecause` says which); they
 * go with the first sync after it is added. `withheld`: lessons that stay on this machine (personal, or an unknown repository).
 */
type SyncResult = { pending: number; held: number; heldBecause?: string[]; withheld: number; synced: number; pulled: number; decisions: DecisionSync | DecisionPreview };

/**
 * Sends what this machine may share and receives the team's. A failure comes out as one line (a missing grant as the
 * GRANT to run), never the driver's stack; the original stays as its `cause`.
 */
/**
 * How long a sync waits to connect to the team database, and for any one query, before it gives up. Both are timed on
 * this machine: a server-side statement_timeout is sent when the connection opens, which a connection pooler such as
 * PgBouncer refuses by default, and only a client-side timer also covers a network that dies mid-query. The connect
 * timeout is shorter than the MCP server's first-sync wait, so an unreachable database is reported as such.
 */
const SYNC_CONNECT_TIMEOUT_MS = 5_000;
const SYNC_QUERY_TIMEOUT_MS = 60_000;

/** The meta key that records when this machine last pulled this team's lessons, for this person. */
function pullMark(config: TeamConfiguration): string {
    return `team_pulled:${config.organizationId}/${config.teamId}/${config.actorId}`;
}

/** Whether this machine has ever pulled the configured team's lessons (false without team mode or a local store). */
export async function hasPulledTeamLessons(): Promise<boolean> {
    const config = await loadTeamConfiguration().catch(() => null);
    if (!config) return false;
    const db = await openDatabase().catch(() => null);
    if (!db) return false;
    try {
        return Boolean((await db.get('SELECT value FROM meta WHERE key = ?', pullMark(config)))?.value);
    } catch {
        return false;
    } finally {
        await db.close();
    }
}

export async function syncTeamOutbox(options: { dryRun?: boolean; cwd: string }): Promise<SyncResult> {
    try {
        return await syncOnce(options);
    } catch (error) {
        throw new Error(explainSyncError(error, (await loadTeamConfiguration().catch(() => undefined))?.databaseUrl), { cause: error });
    }
}

async function syncOnce(options: { dryRun?: boolean; cwd: string }): Promise<SyncResult> {
    const config = await loadTeamConfiguration();
    if (!config?.databaseUrl) throw new Error(await notConfigured());
    const db = await openDatabase();
    if (!db) throw new Error('SQLite offline cache is unavailable.');
    try {
        // All of the queue: held items stay in it, and must not keep what comes after them from being sent.
        const queued = await db.all(`SELECT * FROM sync_outbox WHERE ${QUEUED} ORDER BY created_at ASC`);
        const split = await splitOutbox(db, queued, config);
        const pending = split.sendable.slice(0, SEND_BATCH);
        const counts = outboxCounts(split);
        const decisionInput = { cwd: options.cwd, origin: await originOf(options.cwd), repositoryId: await getRepositoryId(options.cwd), person: personOf(options.cwd), scope: config };
        if (options.dryRun) return { ...counts, synced: 0, pulled: 0, decisions: await previewReviewDecisions(db, decisionInput) };
        await markNotSent(db, split);

        const { Pool } = await loadPg();
        // A stalled connection or query must end the sync, never hang it: the MCP server waits on the first one.
        const pool = new Pool({ connectionString: config.databaseUrl, connectionTimeoutMillis: SYNC_CONNECT_TIMEOUT_MS, query_timeout: SYNC_QUERY_TIMEOUT_MS });
        let synced = 0;
        let pulled = 0;
        let decisions: DecisionSync;
        try {
            const access = await readMembershipAccess(pool, config);
            if (!access) throw new Error(await diagnoseMissingMembership(pool));
            const widened = await widensAccess(db, config, access);
            for (const { item, lesson } of pending) {
                try {
                    const result = await pool.query(
                        `INSERT INTO rigour.lessons (
                        id, organization_id, team_id, repository_id, actor_id, visibility, state,
                        kind, subject, evidence_json, confidence, source, supersedes_id, created_at, updated_at
                    )
                    SELECT $1, membership.organization_id, membership.team_id, $2, COALESCE($16, membership.actor_id),
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
                            config.actorId, config.organizationId, sentActorOf(lesson, access, config.actorId),
                        ],
                    );
                    // The embedding is this login's to write (its policy): under its own actor, whoever wrote the lesson.
                    if (config.semantic && result.rowCount > 0) await upsertTeamLessonEmbedding(pool, config, { ...lesson, actorId: config.actorId });
                    await db.run('UPDATE sync_outbox SET synced_at = ?, last_error = NULL WHERE id = ?', Date.now(), item.id);
                    synced++;
                } catch (error) {
                    const message = String(error instanceof Error ? error.message : error).slice(0, 1_000);
                    // The database refused this one row (row-level security, a constraint): it will refuse it every time,
                    // so it is set aside with the reason and the rest of the queue goes on. Anything else (the
                    // connection, the server) stops the sync and the item is tried again next time.
                    if (refusedRow(error)) {
                        await db.run('UPDATE sync_outbox SET synced_at = ?, last_error = ? WHERE id = ?', Date.now(), `refused by the team database: ${message}`, item.id);
                        continue;
                    }
                    await db.run('UPDATE sync_outbox SET attempts = attempts + 1, last_error = ? WHERE id = ?', message, item.id);
                    throw error;
                }
            }
            // The repository this sync runs in: its person's decisions on review lessons out, the team's in (team-review-decisions.ts).
            decisions = await syncReviewDecisions(pool, db, decisionInput);
            // Only what changed since the last pull, less a margin: updated_at comes from each member's clock, and
            // re-reading a few minutes is harmless (the local write is an upsert) where a skewed clock would lose a lesson.
            const mark = pullMark(config);
            const marked = (await db.get('SELECT value FROM meta WHERE key = ?', mark))?.value;
            // From the start when this login now reads members' candidates: they are older than its last pull.
            const last = widened ? 0 : Number(marked ?? 0);
            // Every team row the database lets this login read: row-level security decides (an sme or owner reads members'
            // candidates where the schema has candidate review; anyone else, and any older schema, the promoted ones).
            const remote = await pool.query(
                `SELECT * FROM rigour.lessons
                 WHERE team_id = $1 AND organization_id = $3
                   AND ((actor_id = $2) OR (visibility = 'team'))
                   AND updated_at > $4
                 ORDER BY updated_at ASC`,
                [config.teamId, config.actorId, config.organizationId, Math.max(0, last - PULL_OVERLAP_MS)],
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
                        updated_at=excluded.updated_at
                    WHERE excluded.updated_at >= lessons.updated_at`,
                    row.id, row.repository_id, row.actor_id, row.team_id, row.visibility, row.state,
                    row.kind, row.subject, await encryptLocalPayload(evidence), row.confidence, row.source,
                    row.supersedes_id, Number(row.created_at), Number(row.updated_at),
                );
                pulled++;
            }
            if (pulled > 0) {
                const newest = Math.max(last, ...remote.rows.map((row: { updated_at: unknown }) => Number(row.updated_at)));
                await db.run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', mark, String(newest));
                await db.run("DELETE FROM context_cache WHERE cache_type = 'semantic'");
            } else if (marked === undefined) {
                // Pulled, found nothing yet: this machine has still pulled the team once (hasPulledTeamLessons).
                await db.run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING', mark, '0');
            }
            await recordTeamAccess(db, config, access);
        } finally {
            await pool.end();
        }
        return { ...counts, synced, pulled, decisions };
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
