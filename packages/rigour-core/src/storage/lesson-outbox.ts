import { randomUUID } from 'crypto';
import { encryptLocalPayload } from './local-encryption.js';
import type { LessonRecord } from './lessons.js';

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
