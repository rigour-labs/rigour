import { createHash, randomUUID } from 'crypto';
import fs from 'fs-extra';
import path from 'path';
import { openDatabase } from './db.js';
import { encryptLocalPayload } from './local-encryption.js';
import { lessonRowToRecord as rowToLesson } from './lesson-record.js';
import { loadTeamConfiguration } from './team-store.js';

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

export function shouldValidateInteractionLesson(evidence: InteractionEvidence, verifiedSuccessfulOutcomes = 0): boolean {
    return evidence.outcome === 'success'
        && Boolean(evidence.reusableClaim?.trim())
        && (evidence.deterministic === true || verifiedSuccessfulOutcomes >= 3);
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

function normalizeRemote(remote: string): string {
    return remote.trim().replace(/^git@([^:]+):/, 'https://$1/').replace(/\.git$/, '').toLowerCase();
}

async function readGitConfig(cwd: string): Promise<string> {
    const dotGit = path.join(cwd, '.git');
    const stat = await fs.stat(dotGit);
    if (stat.isDirectory()) return fs.readFile(path.join(dotGit, 'config'), 'utf8');
    const pointer = await fs.readFile(dotGit, 'utf8');
    const match = pointer.match(/^gitdir:\s*(.+)$/m);
    if (!match) throw new Error('Invalid Git directory pointer.');
    const gitDir = path.resolve(cwd, match[1].trim());
    try {
        return await fs.readFile(path.join(gitDir, 'config'), 'utf8');
    } catch {
        // Linked worktrees usually keep the shared remote configuration here.
        const commonDir = (await fs.readFile(path.join(gitDir, 'commondir'), 'utf8')).trim();
        return fs.readFile(path.resolve(gitDir, commonDir, 'config'), 'utf8');
    }
}

export async function getRepositoryId(cwd: string): Promise<string> {
    let identity = path.resolve(cwd);
    try {
        const config = await readGitConfig(cwd);
        const remote = config.match(/\[remote\s+"origin"\][\s\S]*?url\s*=\s*([^\n]+)/)?.[1];
        if (remote) identity = normalizeRemote(remote);
    } catch {
        // Non-git workspaces retain a stable path-derived local identity.
    }
    return createHash('sha256').update(identity).digest('hex');
}

async function registerRepository(db: { run(sql: string, ...params: unknown[]): Promise<unknown> }, cwd: string, repositoryId: string): Promise<void> {
    let canonicalUri = path.resolve(cwd);
    try {
        const config = await readGitConfig(cwd);
        const remote = config.match(/\[remote\s+"origin"\][\s\S]*?url\s*=\s*([^\n]+)/)?.[1];
        if (remote) canonicalUri = normalizeRemote(remote);
    } catch {
        // Non-git workspaces use their resolved path as the canonical local identity.
    }
    const remoteName = canonicalUri.split('/').filter(Boolean).at(-1);
    await db.run(
        `INSERT INTO repositories (id, canonical_uri, display_name, last_seen) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET canonical_uri=excluded.canonical_uri,
             display_name=excluded.display_name, last_seen=excluded.last_seen`,
        repositoryId, canonicalUri, remoteName || path.basename(cwd), Date.now(),
    );
}

export async function recordInteractionLesson(cwd: string, evidence: InteractionEvidence): Promise<string | null> {
    const db = await openDatabase();
    if (!db) return null;
    try {
        const repositoryId = await getRepositoryId(cwd);
        await registerRepository(db, cwd, repositoryId);
        const id = `lesson-${randomUUID()}`;
        const now = Date.now();
        const verifiedSuccess = shouldValidateInteractionLesson(evidence, evidence.verifiedOutcome ? 3 : 0);
        const confidence = verifiedSuccess ? 0.8 : 0.3;
        const state: LessonState = confidence >= 0.8 ? 'validated' : 'candidate';
        const config = await loadTeamConfiguration();
        const actorId = config?.actorId || process.env.RIGOUR_ACTOR_ID || null;
        const priorRow = await db.get(
            `SELECT * FROM lessons
             WHERE repository_id = ? AND actor_id IS ? AND visibility = 'personal'
               AND state = 'candidate' AND kind = 'interaction' AND subject = ?
             ORDER BY updated_at DESC LIMIT 1`,
            repositoryId, actorId, evidence.reusableClaim?.trim() || `interaction:${evidence.tool}`,
        );
        if (priorRow) {
            const prior = await rowToLesson(priorRow);
            const previousSuccesses = Number(prior.evidence.successfulOutcomes ?? 0);
            const successfulOutcomes = previousSuccesses + (evidence.outcome === 'success' ? 1 : 0);
            const previousVerified = Number(prior.evidence.verifiedSuccessfulOutcomes ?? 0);
            const verifiedSuccessfulOutcomes = previousVerified + (evidence.verifiedOutcome && evidence.outcome === 'success' ? 1 : 0);
            const repeatedValidation = shouldValidateInteractionLesson(evidence, verifiedSuccessfulOutcomes);
            const mergedEvidence = {
                ...evidence,
                observationCount: Number(prior.evidence.observationCount ?? 1) + 1,
                successfulOutcomes,
                verifiedSuccessfulOutcomes,
                previousRequestId: prior.evidence.requestId,
            };
            const updated: LessonRecord = {
                ...prior,
                state: repeatedValidation ? 'validated' : 'candidate',
                evidence: mergedEvidence,
                confidence: repeatedValidation ? 0.8 : Math.min(0.7, prior.confidence + 0.15),
                updatedAt: now,
            };
            await db.run(
                'UPDATE lessons SET state = ?, evidence_json = ?, confidence = ?, updated_at = ? WHERE id = ?',
                updated.state,
                await encryptLocalPayload(updated.evidence),
                updated.confidence,
                updated.updatedAt,
                updated.id,
            );
            if (config) await queueLessonSync(db, updated, now);
            return prior.id;
        }
        const storedEvidence = {
            ...evidence,
            observationCount: 1,
            successfulOutcomes: evidence.outcome === 'success' ? 1 : 0,
            verifiedSuccessfulOutcomes: evidence.verifiedOutcome && evidence.outcome === 'success' ? 1 : 0,
        };
        const encryptedEvidence = await encryptLocalPayload(storedEvidence);
        await db.run(
            `INSERT INTO lessons (
                id, repository_id, actor_id, team_id, visibility, state, kind, subject,
                evidence_json, confidence, source, created_at, updated_at
            ) VALUES (?, ?, ?, ?, 'personal', ?, 'interaction', ?, ?, ?, 'mcp', ?, ?)`,
            id,
            repositoryId,
            actorId,
            config?.teamId || process.env.RIGOUR_TEAM_ID || null,
            state,
            evidence.reusableClaim?.trim() || `interaction:${evidence.tool}`,
            encryptedEvidence,
            confidence,
            now,
            now,
        );
        if (config) {
            const personal = await txSafeLesson(db, id);
            if (personal) await queueLessonSync(db, personal, now);
        }
        return id;
    } finally {
        await db.close();
    }
}

async function queueLessonSync(
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
             WHERE repository_id = ?
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
        const rows = config
            ? await db.all(
                `SELECT lessons.*, repositories.display_name AS repository_name
                 FROM lessons LEFT JOIN repositories ON repositories.id = lessons.repository_id
                 WHERE lessons.repository_id = ?
                    OR (lessons.visibility = 'personal' AND lessons.actor_id = ?)
                    OR (lessons.visibility = 'team' AND lessons.team_id = ? AND lessons.state = 'promoted')
                 ORDER BY lessons.updated_at DESC LIMIT ?`,
                repositoryId, config.actorId, config.teamId, limit,
            )
            : await db.all(
                `SELECT lessons.*, repositories.display_name AS repository_name
                 FROM lessons LEFT JOIN repositories ON repositories.id = lessons.repository_id
                 WHERE lessons.repository_id = ?
                    OR (lessons.visibility = 'personal' AND lessons.actor_id IS NULL)
                 ORDER BY lessons.updated_at DESC LIMIT ?`,
                repositoryId, limit,
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

export async function getApplicableLessons(cwd: string, actorId?: string, teamId?: string): Promise<ApplicableLessons> {
    const repositoryId = await getRepositoryId(cwd);
    const all = await listKnowledgeLessons(cwd, 500);
    const applicable = all
        .filter(lesson => lesson.state === 'validated' || lesson.state === 'promoted')
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

async function txSafeLesson(db: { get(sql: string, ...params: unknown[]): Promise<any> }, id: string): Promise<LessonRecord | null> {
    const row = await db.get('SELECT * FROM lessons WHERE id = ?', id);
    return row ? rowToLesson(row) : null;
}
