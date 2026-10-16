import { createHash, randomUUID } from 'crypto';
import fs from 'fs-extra';
import path from 'path';
import { openDatabase } from './db.js';
import { encryptLocalPayload } from './local-encryption.js';
import { lessonRowToRecord as rowToLesson } from './lesson-record.js';
import { loadTeamConfiguration } from './team-store.js';
import { getRepositoryId, originOf, sameRepositories, sameRepositoryIds } from './repository-origin.js';

export { getRepositoryId };

export type LessonState = 'candidate' | 'validated' | 'promoted' | 'rejected' | 'superseded';
export type LessonVisibility = 'personal' | 'team';

export interface LessonRecord {
    id: string;
    repositoryId: string;
    actorId?: string;
    teamId?: string;
    visibility: LessonVisibility;
    state: LessonState;
    kind: string;
    subject: string;
    evidence: Record<string, unknown>;
    confidence: number;
    source: string;
    supersedesId?: string;
    createdAt: number;
    updatedAt: number;
    repositoryName?: string;
}

export interface InteractionEvidence {
    tool: string;
    outcome: 'success' | 'error' | 'rejected';
    requestId: string;
    taskId?: string;
    agentId?: string;
    deterministic?: boolean;
    verifiedOutcome?: boolean;
    phase?: 'request' | 'response';
    sessionId?: string;
    files?: string[];
    summary?: string;
    /** A concise, evidence-backed proposition that could be reused beyond this call. */
    reusableClaim?: string;
}

export async function recordInteractionEvidence(cwd: string, evidence: InteractionEvidence): Promise<string | null> {
    const db = await openDatabase();
    if (!db) return null;
    try {
        const repositoryId = await getRepositoryId(cwd);
        await registerRepository(db, cwd, repositoryId);
        const config = await loadTeamConfiguration();
        const id = `observation-${randomUUID()}`;
        await db.run(
            `INSERT INTO interaction_events (
                id, repository_id, actor_id, task_id, session_id, request_id,
                tool_name, phase, outcome, deterministic, evidence_json, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            id,
            repositoryId,
            config?.actorId || process.env.RIGOUR_ACTOR_ID || null,
            evidence.taskId || null,
            evidence.sessionId || null,
            evidence.requestId,
            evidence.tool,
            evidence.phase || 'response',
            evidence.outcome,
            evidence.deterministic ? 1 : 0,
            await encryptLocalPayload({ files: evidence.files || [], summary: evidence.summary }),
            Date.now(),
        );
        return id;
    } finally {
        await db.close();
    }
}

export async function countInteractionEvidence(cwd: string): Promise<number> {
    const db = await openDatabase();
    if (!db) return 0;
    try {
        const repositoryId = await getRepositoryId(cwd);
        const row = await db.get(
            'SELECT COUNT(*) AS count FROM interaction_events WHERE repository_id = ?',
            repositoryId,
        );
        return Number(row?.count || 0);
    } finally {
        await db.close();
    }
}


export async function registerRepository(db: { run(sql: string, ...params: unknown[]): Promise<unknown> }, cwd: string, repositoryId: string): Promise<void> {
    // Non-git workspaces use their resolved path as the canonical local identity.
    const canonicalUri = (await originOf(cwd)) ?? path.resolve(cwd);
    const remoteName = canonicalUri.split('/').filter(Boolean).at(-1);
    await db.run(
        `INSERT INTO repositories (id, canonical_uri, display_name, last_seen) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET canonical_uri=excluded.canonical_uri,
             display_name=excluded.display_name, last_seen=excluded.last_seen`,
        repositoryId, canonicalUri, remoteName || path.basename(cwd), Date.now(),
    );
    // The same repository's other id (an https clone's, seen from an SSH alias checkout) is known here too, so a lesson
    // pulled under it can be shared or superseded from this checkout: the sync sends only lessons of known repositories.
    for (const sibling of sameRepositories(cwd).filter(repository => repository.id !== repositoryId)) {
        await db.run(
            `INSERT INTO repositories (id, canonical_uri, display_name, last_seen) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
            sibling.id, sibling.canonicalUri, remoteName || path.basename(cwd), Date.now(),
        );
    }
}

/**
 * Share a memory with the team: a lesson of kind `memory` whose subject is the memory itself.
 * It starts as a team candidate, so teammates' agents only receive it once a person promotes it
 * (team knowledge search serves team lessons in the `promoted` state). Returns the lesson id, or
 * null when the local store is unavailable.
 */
export async function shareMemoryLesson(cwd: string, key: string, value: string): Promise<string | null> {
    const db = await openDatabase();
    if (!db) return null;
    try {
        const repositoryId = await getRepositoryId(cwd);
        await registerRepository(db, cwd, repositoryId);
        const config = await loadTeamConfiguration();
        const now = Date.now();
        const subject = `${key}: ${value}`;
        const actorId = config?.actorId || process.env.RIGOUR_ACTOR_ID || null;
        const teamId = config?.teamId || process.env.RIGOUR_TEAM_ID || null;
        const repositoryIds = sameRepositoryIds(cwd);
        // One check-and-write: two agents remembering the same key at once must not both leave a candidate.
        return await db.transaction(async (tx) => {
            // This person's own (or this machine's, with no actor yet), or one the team shares. A teammate's candidate an
            // sme pulled to decide on is theirs: saving the same memory leaves this person a candidate of their own.
            const existing = await tx.get(
                `SELECT id, state FROM lessons WHERE repository_id IN (${repositoryIds.map(() => '?').join(', ')}) AND kind = 'memory' AND visibility = 'team' AND state != 'superseded'
                   AND (actor_id IS ? OR actor_id IS NULL OR state = 'promoted') AND subject = ?`,
                ...repositoryIds, actorId, subject,
            );
            if (existing) {
                // A candidate saved before team mode was configured was never queued: queue it now. One pulled from the
                // team database is this person's own, so sending it again changes nothing.
                const queued = await tx.get('SELECT 1 FROM sync_outbox WHERE entity_id = ? LIMIT 1', existing.id);
                if (config && existing.state === 'candidate' && !queued) {
                    const lesson = await txSafeLesson(tx, String(existing.id));
                    if (lesson) await queueLessonSync(tx, lesson, now);
                }
                return String(existing.id);
            }
            // A corrected memory replaces its pending candidate: the old one is superseded (and synced so), never left beside it.
            const replaced = await pendingMemoryCandidates(tx, { repositoryIds, key, actorId, teamId });
            const id = `lesson-${randomUUID()}`;
            await tx.run(
                `INSERT INTO lessons (
                    id, repository_id, actor_id, team_id, visibility, state, kind, subject,
                    evidence_json, confidence, source, supersedes_id, created_at, updated_at
                ) VALUES (?, ?, ?, ?, 'team', 'candidate', 'memory', ?, ?, 0.5, 'rigour_remember', ?, ?, ?)`,
                id, repositoryId, actorId, teamId, subject,
                await encryptLocalPayload({ key, value, sharedAt: now }), replaced[0] ?? null, now, now,
            );
            for (const old of replaced) await tx.run("UPDATE lessons SET state = 'superseded', updated_at = ? WHERE id = ?", now, old);
            if (config) {
                for (const changed of [...replaced, id]) {
                    const lesson = await txSafeLesson(tx, changed);
                    if (lesson) await queueLessonSync(tx, lesson, now);
                }
            }
            return id;
        }, { immediate: true });
    } finally {
        await db.close();
    }
}

/**
 * The team memory candidates for `key` that a new value replaces, newest first: this person's (or this machine's, with
 * no actor yet), in this repository and team, still waiting on a person. One a person already promoted is not among
 * them: promotion publishes a copy (source `published:<id>`) and leaves the original as it was, and replacing a
 * published memory is that person's decision, not a side effect of saving.
 */
async function pendingMemoryCandidates(
    db: { all(sql: string, ...params: unknown[]): Promise<any[]> },
    scope: { repositoryIds: string[]; key: string; actorId: string | null; teamId: string | null },
): Promise<string[]> {
    const rows = await db.all(
        `SELECT * FROM lessons
         WHERE repository_id IN (${scope.repositoryIds.map(() => '?').join(', ')}) AND kind = 'memory' AND visibility = 'team' AND state = 'candidate'
           AND substr(subject, 1, length(?) + 2) = ? || ': '
           AND (actor_id IS ? OR actor_id IS NULL) AND (team_id IS ? OR team_id IS NULL)
           AND NOT EXISTS (SELECT 1 FROM lessons published WHERE published.source = 'published:' || lessons.id)
         ORDER BY updated_at DESC`,
        ...scope.repositoryIds, scope.key, scope.key, scope.actorId, scope.teamId,
    );
    const ids: string[] = [];
    for (const row of rows) {
        const lesson = await rowToLesson(row).catch(() => undefined);
        if (lesson?.evidence?.key === scope.key) ids.push(lesson.id);
    }
    return ids;
}

export async function queueLessonSync(
    db: { run(sql: string, ...params: unknown[]): Promise<unknown> },
    lesson: LessonRecord,
    now: number,
): Promise<void> {
    await db.run(
        `INSERT INTO sync_outbox (id, operation, entity_type, entity_id, payload_json, created_at)
         VALUES (?, 'upsert', 'lesson', ?, ?, ?)`,
        `outbox-${randomUUID()}`, lesson.id, await encryptLocalPayload(lesson), now,
    );
}

export async function listLessons(cwd: string, limit = 100): Promise<LessonRecord[]> {
    let db;
    try { db = await openDatabase(); } catch { return []; }
    if (!db) return [];
    try {
        const repositoryId = await getRepositoryId(cwd);
        await registerRepository(db, cwd, repositoryId);
        const rows = await db.all(
            `SELECT lessons.*, repositories.display_name AS repository_name
             FROM lessons LEFT JOIN repositories ON repositories.id = lessons.repository_id
             WHERE repository_id = ? AND kind != 'interaction'
             ORDER BY updated_at DESC LIMIT ?`,
            repositoryId,
            limit,
        );
        return await Promise.all(rows.map(rowToLesson));
    } finally {
        await db.close();
    }
}

/**
 * Returns the evidence visible to the current workspace for exploration. Cross-repository
 * records are candidates only; getApplicableLessons remains the enforcement boundary.
 */
export async function listKnowledgeLessons(cwd: string, limit = 500): Promise<LessonRecord[]> {
    let db;
    try { db = await openDatabase(); } catch { return []; }
    if (!db) return [];
    try {
        const repositoryId = await getRepositoryId(cwd);
        await registerRepository(db, cwd, repositoryId);
        const config = await loadTeamConfiguration();
        // This checkout's lessons, and those filed under the same repository's other remote form (an https clone's).
        const ids = sameRepositoryIds(cwd);
        const marks = ids.map(() => '?').join(', ');
        const rows = config
            ? await db.all(
                `SELECT lessons.*, repositories.display_name AS repository_name
                 FROM lessons LEFT JOIN repositories ON repositories.id = lessons.repository_id
                 WHERE lessons.kind != 'interaction'
                   AND (lessons.repository_id IN (${marks})
                    OR (lessons.visibility = 'personal' AND lessons.actor_id = ?)
                    OR (lessons.visibility = 'team' AND lessons.team_id = ? AND lessons.state = 'promoted'))
                 ORDER BY lessons.updated_at DESC LIMIT ?`,
                ...ids, config.actorId, config.teamId, limit,
            )
            : await db.all(
                `SELECT lessons.*, repositories.display_name AS repository_name
                 FROM lessons LEFT JOIN repositories ON repositories.id = lessons.repository_id
                 WHERE lessons.kind != 'interaction'
                   AND (lessons.repository_id IN (${marks})
                    OR (lessons.visibility = 'personal' AND lessons.actor_id IS NULL))
                 ORDER BY lessons.updated_at DESC LIMIT ?`,
                ...ids, limit,
            );
        return await Promise.all(rows.map(rowToLesson));
    } finally {
        await db.close();
    }
}

export interface ApplicableLessons {
    lessons: Array<LessonRecord & { priority: number; provenance: string }>;
    conflicts: Array<{ subject: string; lessonIds: string[] }>;
}

/**
 * Whether an agent may act on a lesson: validated by evidence, or promoted by a person. Another person's team lesson
 * only once promoted: an sme or owner holds members' candidates to decide on them, never to serve them.
 */
export function isTrustedLesson(lesson: Pick<LessonRecord, 'state' | 'visibility' | 'actorId'>, ownActorId: string | undefined): boolean {
    if (lesson.state === 'promoted') return true;
    if (lesson.state !== 'validated') return false;
    return lesson.visibility !== 'team' || !lesson.actorId || !ownActorId || lesson.actorId === ownActorId;
}

export async function getApplicableLessons(cwd: string, actorId?: string, teamId?: string): Promise<ApplicableLessons> {
    const repositoryId = await getRepositoryId(cwd);
    const own = (await loadTeamConfiguration().catch(() => null))?.actorId;
    const applicable = (await listKnowledgeLessons(cwd, 500))
        .filter(lesson => isTrustedLesson(lesson, own))
        .filter(lesson => lesson.visibility === 'team' || !actorId || !lesson.actorId || lesson.actorId === actorId)
        .filter(lesson => !teamId || !lesson.teamId || lesson.teamId === teamId)
        .map(lesson => {
            const priority = lesson.repositoryId === repositoryId ? 1 : lesson.visibility === 'personal' ? 2 : 3;
            return { ...lesson, priority, provenance: `${lesson.visibility}:${lesson.source}:${lesson.id}` };
        })
        .sort((a, b) => a.priority - b.priority || b.confidence - a.confidence);
    const bySubject = new Map<string, typeof applicable>();
    for (const lesson of applicable) bySubject.set(lesson.subject, [...(bySubject.get(lesson.subject) ?? []), lesson]);
    const conflicts = [...bySubject.entries()]
        .filter(([, lessons]) => new Set(lessons.map(lesson => JSON.stringify(lesson.evidence))).size > 1)
        .map(([subject, lessons]) => ({ subject, lessonIds: lessons.map(lesson => lesson.id) }));
    return { lessons: applicable, conflicts };
}

export async function transitionLesson(
    id: string,
    state: LessonState,
    options: { visibility?: LessonVisibility; queueSync?: boolean } = {},
): Promise<boolean> {
    const db = await openDatabase();
    if (!db) return false;
    const now = Date.now();
    try {
        return await db.transaction(async (tx) => {
            const existing = await tx.get('SELECT * FROM lessons WHERE id = ?', id);
            if (!existing) return false;
            const visibility = options.visibility ?? existing.visibility;
            if (state === 'promoted' && visibility === 'team') {
                const teamConfig = await loadTeamConfiguration();
                if (!teamConfig) {
                    throw new Error('Configure PostgreSQL team mode before publishing a team lesson.');
                }
                const source = await rowToLesson(existing);
                const publishedId = `lesson-${randomUUID()}`;
                const published: LessonRecord = {
                    ...source,
                    id: publishedId,
                    actorId: source.actorId || teamConfig.actorId,
                    teamId: teamConfig.teamId,
                    visibility: 'team',
                    state: 'promoted',
                    source: `published:${source.id}`,
                    // Who shared it: the copy keeps its author's actor, and an sme or owner may share a member's candidate.
                    evidence: { ...source.evidence, publishedBy: teamConfig.actorId },
                    createdAt: now,
                    updatedAt: now,
                };
                await tx.run(
                    `INSERT INTO lessons (
                        id, repository_id, actor_id, team_id, visibility, state, kind, subject,
                        evidence_json, confidence, source, supersedes_id, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    published.id, published.repositoryId, published.actorId || null, published.teamId || null,
                    published.visibility, published.state, published.kind, published.subject,
                    await encryptLocalPayload(published.evidence), published.confidence, published.source,
                    published.supersedesId || null, published.createdAt, published.updatedAt,
                );
                if (options.queueSync) {
                    await tx.run(
                        `INSERT INTO sync_outbox (id, operation, entity_type, entity_id, payload_json, created_at)
                         VALUES (?, 'upsert', 'lesson', ?, ?, ?)`,
                        `outbox-${randomUUID()}`, published.id, await encryptLocalPayload(published), now,
                    );
                }
                await tx.run("DELETE FROM context_cache WHERE cache_type = 'semantic'");
                return true;
            }
            const result = await tx.run(
                'UPDATE lessons SET state = ?, visibility = ?, updated_at = ? WHERE id = ?',
                state,
                visibility,
                now,
                id,
            );
            if (result.changes > 0) await tx.run("DELETE FROM context_cache WHERE cache_type = 'semantic'");
            if (result.changes > 0 && options.queueSync && visibility === 'team') {
                const payload = { ...await rowToLesson(existing), state, visibility, updatedAt: now };
                await tx.run(
                    `INSERT INTO sync_outbox (
                        id, operation, entity_type, entity_id, payload_json, created_at
                    ) VALUES (?, 'upsert', 'lesson', ?, ?, ?)`,
                    `outbox-${randomUUID()}`,
                    id,
                    await encryptLocalPayload(payload),
                    now,
                );
            }
            return result.changes > 0;
        });
    } finally {
        await db.close();
    }
}

export async function txSafeLesson(db: { get(sql: string, ...params: unknown[]): Promise<any> }, id: string): Promise<LessonRecord | null> {
    const row = await db.get('SELECT * FROM lessons WHERE id = ?', id);
    return row ? rowToLesson(row) : null;
}
