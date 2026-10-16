/**
 * Shared team lessons this machine holds that the team database no longer shares. A member's login reads only promoted
 * team rows, so when a person takes one back or a newer version replaces it, the pull never brings the change: the
 * row simply stops being readable. Each sync asks which of the shared rows it holds are still shared, and stops
 * serving the rest (superseded here; a later pull that can read the row brings its exact state).
 */
interface Pool { query(sql: string, params?: unknown[]): Promise<{ rows: any[] }> }
interface Db {
    all(sql: string, ...params: unknown[]): Promise<any[]>;
    run(sql: string, ...params: unknown[]): Promise<unknown>;
}

/** How many ids one question to the team database carries. */
const CHUNK = 500;

/** Retires the shared lessons of `teamId` the team database no longer shares with this login; returns how many. */
export async function retireUnshared(pool: Pool, db: Db, teamId: string): Promise<number> {
    // Only rows the team database has: pulled ones, and those sent without error. One still queued, held or refused
    // here was never there, and stays.
    const held = (await db.all(
        `SELECT id FROM lessons
         WHERE visibility = 'team' AND state = 'promoted' AND team_id = ?
           AND NOT EXISTS (SELECT 1 FROM sync_outbox outbox WHERE outbox.entity_id = lessons.id AND (outbox.synced_at IS NULL OR outbox.last_error IS NOT NULL))`,
        teamId,
    )).map(row => String(row.id));
    let retired = 0;
    for (let i = 0; i < held.length; i += CHUNK) {
        const ids = held.slice(i, i + CHUNK);
        const shared = new Set((await pool.query(`SELECT id FROM rigour.lessons WHERE id = ANY($1::text[]) AND state = 'promoted'`, [ids])).rows.map(row => String(row.id)));
        for (const id of ids.filter(id => !shared.has(id))) {
            await db.run("UPDATE lessons SET state = 'superseded' WHERE id = ? AND state = 'promoted'", id);
            retired++;
        }
    }
    return retired;
}
