import { randomUUID } from 'crypto';
import { encryptLocalPayload } from './local-encryption.js';
import type { LessonRecord } from './lessons.js';

/**
 * When a local change to a lesson happens: now, or just after its last change when that came from a clock ahead of
 * this one. The team database applies a change only over an older version, so a later change must never look older.
 */
export function nextUpdatedAt(previous: unknown, now: number): number {
    return Math.max(now, Number(previous ?? 0) + 1);
}

/** Queues a lesson's current version for the team database (sync_outbox); a sync sends it, or holds it, and says why. */
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
