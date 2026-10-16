/**
 * What a team sync sends, holds and keeps from the local outbox (sync_outbox). A lesson from a repository the team does
 * not list yet is held: it stays queued and goes with the first sync after the repository is added.
 */
import { openDatabase } from './db.js';
import { decryptLocalPayload } from './local-encryption.js';
import { withheldReason, type TeamScope } from './team-scope.js';

/**
 * Outbox rows still to send. Versions before 7.0.7 set a lesson from a repository missing from the team's list aside for
 * good (`synced_at` stamped, `not sent: repository …`); those are queued again, so they go once the repository is added.
 */
export const QUEUED = `synced_at IS NULL OR (last_error LIKE 'not sent: repository %' AND last_error NOT LIKE 'not sent: repository unknown%')`;

/** How many queued lessons one sync sends; the rest go with the next. */
export const SEND_BATCH = 200;

export async function queuedChanges(): Promise<number> {
    let db;
    try { db = await openDatabase(); } catch { return 0; }
    if (!db) return 0;
    try {
        const row = await db.get(`SELECT COUNT(*) AS count FROM sync_outbox WHERE ${QUEUED}`);
        return Number(row?.count ?? 0);
    } finally {
        await db.close();
    }
}

/**
 * Queued items split into those this team may receive, those held until their repository is in the team's list, and
 * those that stay on this machine, with why.
 */
export async function splitOutbox(db: { get(sql: string, ...params: unknown[]): Promise<any> }, queued: any[], config: TeamScope) {
    const sendable: Array<{ item: any; lesson: any }> = [];
    const held: Array<{ id: string; reason: string }> = [];
    const withheld: Array<{ id: string; reason: string }> = [];
    for (const item of queued) {
        const lesson = await decryptLocalPayload<any>(item.payload_json);
        const repo = await db.get('SELECT canonical_uri FROM repositories WHERE id = ?', lesson.repositoryId);
        const why = withheldReason(lesson.visibility, repo?.canonical_uri, config);
        if (!why) sendable.push({ item, lesson });
        else (why.held ? held : withheld).push({ id: item.id, reason: why.reason });
    }
    return { sendable, held, withheld };
}

type Split = Awaited<ReturnType<typeof splitOutbox>>;

/** What a sync reports about the queue: `heldBecause` lists why lessons are held, when any are. */
export function outboxCounts({ sendable, held, withheld }: Split) {
    const heldBecause = [...new Set(held.map(item => item.reason))];
    return { pending: sendable.length, held: held.length, ...(heldBecause.length ? { heldBecause } : {}), withheld: withheld.length };
}

/** Held items stay queued with their reason; withheld ones are set aside for good. */
export async function markNotSent(db: { run(sql: string, ...params: unknown[]): Promise<unknown> }, { held, withheld }: Split): Promise<void> {
    for (const item of held) {
        // Written once, not at every sync: the reason stays until the repository is added.
        const reason = `held: ${item.reason}`;
        await db.run('UPDATE sync_outbox SET synced_at = NULL, last_error = ? WHERE id = ? AND (synced_at IS NOT NULL OR last_error IS NOT ?)', reason, item.id, reason);
    }
    for (const item of withheld) {
        await db.run('UPDATE sync_outbox SET synced_at = ?, last_error = ? WHERE id = ?', Date.now(), `not sent: ${item.reason}`, item.id);
    }
}

/** Changes the team database refused since `since` (ms): how many, and the latest one's reason. */
export async function refusedChanges(since: number): Promise<{ count: number; latest?: string }> {
    const db = await openDatabase().catch(() => null);
    if (!db) return { count: 0 };
    try {
        const refused = `last_error LIKE 'refused by the team database:%' AND created_at >= ?`;
        const count = Number((await db.get(`SELECT COUNT(*) AS count FROM sync_outbox WHERE ${refused}`, since))?.count ?? 0);
        const latest = count ? (await db.get(`SELECT last_error FROM sync_outbox WHERE ${refused} ORDER BY created_at DESC, rowid DESC LIMIT 1`, since))?.last_error : undefined;
        return { count, ...(latest ? { latest: String(latest) } : {}) };
    } finally {
        await db.close();
    }
}

/** Where one lesson's latest change stands in the queue to the team database. */
export type TeamSendState = { state: 'sent' | 'in the team database' } | { state: 'held' | 'not sent' | 'queued'; reason?: string };

/**
 * Whether the team database has the latest change to lesson `lessonId`: sent; held (its repository isn't in the team's
 * list yet); not sent (set aside, with the reason); or still queued (not tried yet, or the last try failed).
 */
export async function teamSendStateOf(lessonId: string): Promise<TeamSendState> {
    const db = await openDatabase().catch(() => null);
    if (!db) return { state: 'queued' };
    try {
        const row = await db.get('SELECT synced_at, last_error FROM sync_outbox WHERE entity_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', lessonId);
        if (!row) {
            // Never queued here: a promoted team lesson pulled from the team database (a candidate is always queued when saved).
            const lesson = await db.get('SELECT team_id, state FROM lessons WHERE id = ?', lessonId);
            return lesson?.team_id && lesson.state === 'promoted' ? { state: 'in the team database' } : { state: 'queued' };
        }
        const error = row.last_error ? String(row.last_error) : undefined;
        if (row.synced_at && !error) return { state: 'sent' };
        if (error?.startsWith('held: ')) return { state: 'held', reason: error.slice('held: '.length) };
        if (row.synced_at) return { state: 'not sent', reason: error?.replace(/^not sent: /, '') };
        return { state: 'queued', ...(error ? { reason: error } : {}) };
    } finally {
        await db.close();
    }
}
