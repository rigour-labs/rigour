/**
 * One lesson to the team database and the team's lessons back, for a sync (team-store.ts). A change the database
 * refuses, or does not apply because it holds a newer version, is set aside with why, and this machine takes the
 * team database's version of the lesson: a refused or stale change never leaves the local store diverged.
 */
import { encryptLocalPayload } from './local-encryption.js';
import { refusedRow } from './team-diagnostics.js';
import { sentActorOf, type TeamAccess } from './team-access.js';
import { upsertTeamLessonEmbedding } from './team-vector-store.js';
import type { TeamConfiguration } from './team-store.js';

type Pool = Parameters<typeof upsertTeamLessonEmbedding>[0];
interface Db {
    get(sql: string, ...params: unknown[]): Promise<any>;
    run(sql: string, ...params: unknown[]): Promise<unknown>;
}

/** Said of a change the team database did not apply because it holds a newer version of the lesson. */
const NEWER_ON_SERVER = 'not sent: the team database has a newer version of this lesson; this machine now has it';

const UPSERT = `INSERT INTO rigour.lessons (
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
    RETURNING id`;

/**
 * Sends one queued lesson. Returns whether the team database took it; a refusal (row-level security, a constraint, the
 * lesson guard) or a newer version there is set aside with why, and the local lesson becomes the team database's.
 * Anything else (the connection, the server) is thrown: the item stays queued.
 */
export async function pushLesson(pool: Pool, db: Db, config: TeamConfiguration, access: TeamAccess, item: { id: string }, lesson: any): Promise<boolean> {
    try {
        const result = await pool.query(UPSERT, [
            lesson.id, lesson.repositoryId, lesson.visibility, lesson.state, lesson.kind,
            lesson.subject, JSON.stringify(lesson.evidence), lesson.confidence, lesson.source,
            lesson.supersedesId ?? null, lesson.createdAt, lesson.updatedAt, config.teamId,
            config.actorId, config.organizationId, sentActorOf(lesson, access, config.actorId),
        ]);
        if (!result.rowCount) {
            await db.run('UPDATE sync_outbox SET synced_at = ?, last_error = ? WHERE id = ?', Date.now(), NEWER_ON_SERVER, item.id);
            await restoreFromServer(pool, db, lesson.id);
            return false;
        }
        // The embedding is this login's to write (its policy): under its own actor, whoever wrote the lesson.
        if (config.semantic) await upsertTeamLessonEmbedding(pool, config, { ...lesson, actorId: config.actorId });
        await db.run('UPDATE sync_outbox SET synced_at = ?, last_error = NULL WHERE id = ?', Date.now(), item.id);
        await db.run('UPDATE lessons SET on_server = 1 WHERE id = ?', lesson.id);
        return true;
    } catch (error) {
        const message = String(error instanceof Error ? error.message : error).slice(0, 1_000);
        if (!refusedRow(error)) {
            await db.run('UPDATE sync_outbox SET attempts = attempts + 1, last_error = ? WHERE id = ?', message, item.id);
            throw error;
        }
        // Refused: it will be refused every time, so it is set aside with the reason and the rest of the queue goes on.
        await db.run('UPDATE sync_outbox SET synced_at = ?, last_error = ? WHERE id = ?', Date.now(), `refused by the team database: ${message}`, item.id);
        await restoreFromServer(pool, db, lesson.id);
        return false;
    }
}

/**
 * Writes a lesson read from the team database here. It replaces the local one unless that has a change still waiting
 * to be sent (newer or not: the team's version wins once nothing here is pending), or `force`.
 */
export async function writePulledLesson(db: Db, row: any, force = false): Promise<void> {
    const evidence = typeof row.evidence_json === 'string' ? JSON.parse(row.evidence_json) : row.evidence_json;
    await db.run(
        `INSERT INTO lessons (
            id, repository_id, actor_id, team_id, visibility, state, kind, subject,
            evidence_json, confidence, source, supersedes_id, created_at, updated_at, on_server, decided_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
        ON CONFLICT(id) DO UPDATE SET
            visibility=excluded.visibility, state=excluded.state, evidence_json=excluded.evidence_json,
            confidence=excluded.confidence, source=excluded.source, supersedes_id=excluded.supersedes_id,
            updated_at=excluded.updated_at, on_server=1, decided_by=excluded.decided_by
        WHERE ? OR excluded.updated_at >= lessons.updated_at
           OR NOT EXISTS (SELECT 1 FROM sync_outbox pending WHERE pending.entity_id = lessons.id AND pending.synced_at IS NULL)`,
        row.id, row.repository_id, row.actor_id, row.team_id, row.visibility, row.state,
        row.kind, row.subject, await encryptLocalPayload(evidence), row.confidence, row.source,
        row.supersedes_id, Number(row.created_at), Number(row.updated_at), row.decided_by ?? null, force ? 1 : 0,
    );
}

/**
 * Takes the team database's version of a lesson after a change to it was refused or not applied. A shared copy the
 * team database never took (its row is not there) is removed here: it was never shared, and must not be served.
 */
async function restoreFromServer(pool: Pool, db: Db, id: string): Promise<void> {
    const row = (await pool.query('SELECT * FROM rigour.lessons WHERE id = $1', [id])).rows[0];
    if (row) {
        await writePulledLesson(db, row, true);
    } else {
        await db.run("DELETE FROM lessons WHERE id = ? AND on_server = 0 AND state = 'promoted' AND source LIKE 'published:%'", id);
    }
    await db.run("DELETE FROM context_cache WHERE cache_type = 'semantic'");
}
