/**
 * One shared version per team memory key. Sharing a memory retires the versions of its key the team shares now
 * (superseded, marked with who shared the new one), and a person can take a shared version back: superseded when a
 * newer shared version of its key exists, rejected otherwise. Each change is queued for the team database.
 */
import { openDatabase } from './db.js';
import { encryptLocalPayload } from './local-encryption.js';
import { lessonRowToRecord } from './lesson-record.js';
import { queueLessonSync } from './lesson-outbox.js';
import { loadTeamConfiguration } from './team-store.js';
import type { LessonRecord, LessonState } from './lessons.js';

interface Tx {
    get(sql: string, ...params: unknown[]): Promise<any>;
    all(sql: string, ...params: unknown[]): Promise<any[]>;
    run(sql: string, ...params: unknown[]): Promise<{ changes?: number } | unknown>;
}

/** A team memory's key: its subject before ': ' (the subject is `key: value`); undefined for any other lesson. */
function memoryKeyOf(lesson: { kind: string; subject: string }): string | undefined {
    const split = lesson.kind === 'memory' ? lesson.subject.indexOf(': ') : -1;
    return split > 0 ? lesson.subject.slice(0, split) : undefined;
}

/** The team's shared (promoted) memories of `key` in these repositories, newest first. */
async function sharedForKey(tx: Tx, scope: { repositoryIds: string[]; teamId: string | null; key: string }): Promise<any[]> {
    return tx.all(
        `SELECT * FROM lessons
         WHERE repository_id IN (${scope.repositoryIds.map(() => '?').join(', ')}) AND kind = 'memory' AND visibility = 'team'
           AND state = 'promoted' AND (team_id IS ? OR team_id IS NULL) AND substr(subject, 1, length(?) + 2) = ? || ': '
         ORDER BY created_at DESC`,
        ...scope.repositoryIds, scope.teamId, scope.key, scope.key,
    );
}

/** Sets a lesson's state, records who decided under `mark` in its evidence, and queues it when team mode is on. */
async function retire(tx: Tx, row: Record<string, unknown>, change: { state: LessonState; mark: string; by?: string; now: number; queue: boolean }): Promise<void> {
    const lesson = await lessonRowToRecord(row);
    const evidence = change.by ? { ...lesson.evidence, [change.mark]: change.by } : lesson.evidence;
    await tx.run('UPDATE lessons SET state = ?, evidence_json = ?, updated_at = ? WHERE id = ?', change.state, await encryptLocalPayload(evidence), change.now, lesson.id);
    if (change.queue) await queueLessonSync(tx, { ...lesson, state: change.state, evidence, updatedAt: change.now }, change.now);
}

/**
 * Retires the shared versions of a team memory's key that `published` replaces: each superseded, marked
 * `supersededBy` the sharer, and queued with it. Returns their ids, newest first (the new version supersedes the first).
 */
export async function supersedeShared(tx: Tx, published: LessonRecord, scope: { repositoryIds: string[]; sharer: string; now: number }): Promise<string[]> {
    const key = memoryKeyOf(published);
    if (!key || published.visibility !== 'team') return [];
    const rows = (await sharedForKey(tx, { repositoryIds: scope.repositoryIds, teamId: published.teamId ?? null, key })).filter(row => row.id !== published.id);
    for (const row of rows) await retire(tx, row, { state: 'superseded', mark: 'supersededBy', by: scope.sharer, now: scope.now, queue: true });
    return rows.map(row => String(row.id));
}

/**
 * Takes back a shared team memory: superseded when a newer shared version of its key exists, rejected otherwise;
 * marked `takenBackBy` this person and queued. Returns the new state, or null when `id` is no shared team memory.
 */
export async function takeBackTeamMemory(id: string, repositoryIds?: string[]): Promise<LessonState | null> {
    const db = await openDatabase();
    if (!db) return null;
    const config = await loadTeamConfiguration();
    const by = config?.actorId ?? process.env.RIGOUR_ACTOR_ID;
    try {
        return await db.transaction(async (tx) => {
            const row = await tx.get('SELECT * FROM lessons WHERE id = ?', id);
            const key = row && memoryKeyOf({ kind: String(row.kind), subject: String(row.subject) });
            if (!key || row.visibility !== 'team' || row.state !== 'promoted') return null;
            const ids = repositoryIds?.length ? repositoryIds : [String(row.repository_id)];
            const newer = (await sharedForKey(tx, { repositoryIds: ids, teamId: row.team_id ?? null, key })).some(other => other.id !== id && Number(other.created_at) > Number(row.created_at));
            const state: LessonState = newer ? 'superseded' : 'rejected';
            await retire(tx, row, { state, mark: 'takenBackBy', by, now: Date.now(), queue: Boolean(config) });
            await tx.run("DELETE FROM context_cache WHERE cache_type = 'semantic'");
            return state;
        });
    } finally {
        await db.close();
    }
}
