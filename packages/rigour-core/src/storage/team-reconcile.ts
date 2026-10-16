/**
 * Keeping this machine's copy of the team's lessons in step with what the team database shares with this login:
 * - Shared lessons it holds that the team no longer shares, or never took, stop being served. A member's login reads only promoted
 *   rows, so when a person takes one back or a newer version replaces it the pull never brings the change: the row
 *   just stops being readable. Each sync asks which of the shared rows it took from the team database are still
 *   shared (whatever happened to a local change since), and marks the rest superseded here.
 * - Team candidates of this person's that the database refused before its candidate rules arrived go again, once.
 * - A demoted sme's machine lets go of the teammates' candidates it held to decide on.
 */
import { decryptLocalPayload } from './local-encryption.js';

interface Pool { query(sql: string, params?: unknown[]): Promise<{ rows: any[] }> }
interface Db {
    all(sql: string, ...params: unknown[]): Promise<any[]>;
    run(sql: string, ...params: unknown[]): Promise<unknown>;
}
interface Scope { organizationId: string; teamId: string; actorId: string }

/** How many ids one question to the team database carries. */
const CHUNK = 500;
/** A local change to the lesson still waiting to be sent: it is this machine's to decide, not the pull's. */
const NOTHING_PENDING = 'NOT EXISTS (SELECT 1 FROM sync_outbox pending WHERE pending.entity_id = lessons.id AND pending.synced_at IS NULL)';

/**
 * A shared lesson this machine holds that the team database may never have taken: not known to be there, nothing
 * pending, never sent without error, and not kept here on purpose (`not sent:` a repository the team does not list). A
 * shared copy an older Rigour made for a member, which the database refused, is one.
 */
const NEVER_TAKEN = `on_server = 0 AND ${NOTHING_PENDING}
    AND NOT EXISTS (SELECT 1 FROM sync_outbox sent WHERE sent.entity_id = lessons.id AND sent.synced_at IS NOT NULL AND sent.last_error IS NULL)
    AND NOT EXISTS (SELECT 1 FROM sync_outbox kept WHERE kept.entity_id = lessons.id AND kept.last_error LIKE 'not sent: %')`;

/**
 * Stops serving the shared lessons of the team that the team database does not share with this login: those it took
 * and no longer shares become superseded here; a shared copy it never took is removed (it was never shared; its
 * candidate is offered again). One it does share, never known here to be there, is marked so. Returns how many changed.
 */
export async function retireUnshared(pool: Pool, db: Db, scope: Scope): Promise<number> {
    const held = await db.all(
        `SELECT id, on_server, source FROM lessons WHERE visibility = 'team' AND state = 'promoted' AND team_id = ?
           AND ((on_server = 1 AND ${NOTHING_PENDING}) OR (${NEVER_TAKEN}))`,
        scope.teamId,
    );
    let retired = 0;
    for (let i = 0; i < held.length; i += CHUNK) {
        const rows = held.slice(i, i + CHUNK);
        const shared = new Set((await pool.query(
            `SELECT id FROM rigour.lessons WHERE id = ANY($1::text[]) AND organization_id = $2 AND team_id = $3 AND state = 'promoted'`,
            [rows.map(row => String(row.id)), scope.organizationId, scope.teamId],
        )).rows.map(row => String(row.id)));
        for (const row of rows) {
            if (shared.has(String(row.id))) {
                if (!Number(row.on_server)) await db.run('UPDATE lessons SET on_server = 1 WHERE id = ?', row.id);
                continue;
            }
            const neverShared = !Number(row.on_server) && String(row.source).startsWith('published:');
            await db.run(neverShared ? 'DELETE FROM lessons WHERE id = ?' : "UPDATE lessons SET state = 'superseded' WHERE id = ? AND state = 'promoted'", row.id);
            retired++;
        }
    }
    return retired;
}

/** Puts back in the queue this person's team candidates the team database refused (lessons only); returns how many. */
export async function requeueRefusedCandidates(db: Db, actorId: string): Promise<number> {
    const refused = await db.all(`SELECT id, payload_json FROM sync_outbox WHERE entity_type = 'lesson' AND last_error LIKE 'refused by the team database:%'`);
    let requeued = 0;
    for (const item of refused) {
        const lesson = await decryptLocalPayload<{ visibility?: string; state?: string; actorId?: string }>(String(item.payload_json)).catch(() => undefined);
        const own = !lesson?.actorId || lesson.actorId === actorId;
        if (!lesson || !own || lesson.visibility !== 'team' || (lesson.state !== 'candidate' && lesson.state !== 'superseded')) continue;
        await db.run('UPDATE sync_outbox SET synced_at = NULL, last_error = NULL WHERE id = ?', item.id);
        requeued++;
    }
    return requeued;
}

/** Removes the teammates' team lessons this machine held to decide on (all but the shared ones). */
export async function dropTeammatesCandidates(db: Db, scope: Scope): Promise<void> {
    await db.run(
        `DELETE FROM lessons WHERE team_id = ? AND visibility = 'team' AND state != 'promoted'
           AND actor_id IS NOT NULL AND actor_id != ? AND ${NOTHING_PENDING}`,
        scope.teamId, scope.actorId,
    );
}
