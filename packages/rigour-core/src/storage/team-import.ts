import { createHash } from 'node:crypto';
import { openDatabase, type RigourDB } from './db.js';
import { decryptLocalPayload, encryptLocalPayload } from './local-encryption.js';
import { lessonRowToRecord } from './lesson-record.js';
import { getRepositoryId, type LessonRecord } from './lessons.js';
import { loadTeamConfiguration, type TeamConfiguration } from './team-store.js';

export interface LocalLessonImportResult {
    dryRun: boolean;
    repositoryIds: string[];
    matched: number;
    eligible: number;
    queued: number;
    wouldQueue: number;
    alreadyQueued: number;
    skippedOwnership: number;
    skippedVisibility: number;
}

export interface LocalLessonImportOptions {
    dryRun?: boolean;
    databasePath?: string;
}

function createResult(repositoryIds: string[], dryRun: boolean): LocalLessonImportResult {
    return {
        dryRun,
        repositoryIds,
        matched: 0,
        eligible: 0,
        queued: 0,
        wouldQueue: 0,
        alreadyQueued: 0,
        skippedOwnership: 0,
        skippedVisibility: 0,
    };
}

function importOutboxId(lesson: LessonRecord, config: TeamConfiguration): string {
    const identity = [lesson.id, lesson.updatedAt, config.organizationId, config.teamId, config.actorId].join('\0');
    return `outbox-import-${createHash('sha256').update(identity).digest('hex')}`;
}

async function hasQueuedLessonVersion(db: RigourDB, lesson: LessonRecord): Promise<boolean> {
    const rows = await db.all(
        `SELECT payload_json FROM sync_outbox
         WHERE entity_type = 'lesson' AND entity_id = ?`,
        lesson.id,
    );
    for (const row of rows) {
        try {
            const payload = await decryptLocalPayload<Partial<LessonRecord>>(String(row.payload_json));
            if (
                payload.id === lesson.id
                && payload.updatedAt === lesson.updatedAt
                && payload.actorId === lesson.actorId
                && payload.teamId === lesson.teamId
                && payload.visibility === lesson.visibility
            ) return true;
        } catch {
            // Ignore unreadable legacy entries and queue a recoverable replacement.
        }
    }
    return false;
}

async function queueLesson(
    db: RigourDB,
    row: Record<string, unknown>,
    config: TeamConfiguration,
    result: LocalLessonImportResult,
): Promise<void> {
    const lesson = await lessonRowToRecord(row);
    const normalized = { ...lesson, actorId: config.actorId, teamId: config.teamId, visibility: 'personal' as const };
    const outboxId = importOutboxId(normalized, config);
    const existing = await hasQueuedLessonVersion(db, normalized);
    result.eligible++;
    if (existing) result.alreadyQueued++;
    else result.wouldQueue++;
    if (result.dryRun) return;

    await db.run('UPDATE lessons SET actor_id = ?, team_id = ? WHERE id = ?', config.actorId, config.teamId, lesson.id);
    if (existing) return;
    await db.run(
        `INSERT INTO sync_outbox (id, operation, entity_type, entity_id, payload_json, created_at)
         VALUES (?, 'upsert', 'lesson', ?, ?, ?)`,
        outboxId,
        normalized.id,
        await encryptLocalPayload(normalized),
        Date.now(),
    );
    result.queued++;
}

async function queueEligibleRows(
    db: RigourDB,
    rows: Record<string, unknown>[],
    config: TeamConfiguration,
    result: LocalLessonImportResult,
): Promise<void> {
    for (const row of rows) {
        if (row.visibility !== 'personal') {
            result.skippedVisibility++;
        } else if (row.actor_id && row.actor_id !== config.actorId) {
            result.skippedOwnership++;
        } else {
            await queueLesson(db, row, config, result);
        }
    }
}

/** Queue pre-team-mode personal lessons without publishing or promoting them. */
export async function queueLocalLessonsForTeam(
    repositoryPaths: string[],
    options: LocalLessonImportOptions = {},
): Promise<LocalLessonImportResult> {
    if (repositoryPaths.length === 0) throw new Error('At least one repository path is required.');
    const config = await loadTeamConfiguration();
    if (!config) throw new Error('Configure PostgreSQL team mode before importing local lessons.');
    const repositoryIds = [...new Set(await Promise.all(repositoryPaths.map(getRepositoryId)))];
    const db = await openDatabase(options.databasePath);
    if (!db) throw new Error('SQLite local cache is unavailable.');
    const result = createResult(repositoryIds, Boolean(options.dryRun));
    try {
        const placeholders = repositoryIds.map(() => '?').join(', ');
        const rows = await db.all(
            `SELECT * FROM lessons WHERE repository_id IN (${placeholders}) ORDER BY updated_at ASC`,
            ...repositoryIds,
        );
        result.matched = rows.length;
        await db.transaction(tx => queueEligibleRows(tx, rows, config, result));
        return result;
    } finally {
        await db.close();
    }
}
