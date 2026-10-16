import { describe, expect, it } from 'vitest';
import { openDatabase } from './db.js';
import { encryptLocalPayload } from './local-encryption.js';
import { refusedChanges } from './team-outbox.js';
import { writePulledLesson } from './team-sync-lessons.js';

const server = (state: string, updatedAt: number) => ({
    id: 'lesson-w', repository_id: 'r', actor_id: 'dev-a', team_id: 'web', visibility: 'team', state, kind: 'memory', subject: 'w: x',
    evidence_json: { key: 'w', value: 'x' }, confidence: 0.9, source: 'published:c', supersedes_id: null, created_at: 1, updated_at: updatedAt, decided_by: 'owner-o',
});

describe("the team database's version of a lesson, here", () => {
    it('takes an older version only once nothing here waits to be sent, and a newer one always', async () => {
        const db = (await openDatabase())!;
        try {
            const local = async () => (await db.get(`SELECT state, decided_by FROM lessons WHERE id = 'lesson-w'`));
            await writePulledLesson(db, server('promoted', 10));
            await db.run(`UPDATE lessons SET state = 'rejected', updated_at = 20 WHERE id = 'lesson-w'`);
            await db.run(`INSERT INTO sync_outbox (id, operation, entity_type, entity_id, payload_json, created_at) VALUES ('outbox-w', 'upsert', 'lesson', 'lesson-w', ?, 20)`, await encryptLocalPayload({}));
            await writePulledLesson(db, server('promoted', 10));
            expect(await local()).toEqual({ state: 'rejected', decided_by: 'owner-o' }); // a later change still queued stays
            await db.run(`UPDATE sync_outbox SET synced_at = 21, last_error = 'refused by the team database: policy' WHERE id = 'outbox-w'`);
            await writePulledLesson(db, server('promoted', 10));
            expect(await local()).toEqual({ state: 'promoted', decided_by: 'owner-o' });
            await db.run(`INSERT INTO sync_outbox (id, operation, entity_type, entity_id, payload_json, created_at, synced_at, last_error)
                VALUES ('outbox-v', 'upsert', 'lesson', 'lesson-w', ?, ?, ?, 'not sent: the team database has a newer version of this lesson; this machine now has it')`, await encryptLocalPayload({}), Date.now(), Date.now());
        } finally {
            await db.close();
        }
        // Both what the team database refused and what it did not apply are counted, the latest first.
        expect(await refusedChanges(0)).toEqual({ count: 2, latest: 'not sent: the team database has a newer version of this lesson; this machine now has it' });
    });
});
