/**
 * What rigour_remember tells an agent about one team candidate comes from that candidate's own latest queue entry, so
 * a save is never reported as sent unless the team database took it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ outbox: undefined as Record<string, unknown> | undefined, lesson: undefined as Record<string, unknown> | undefined }));

vi.mock('./db.js', () => ({
    openDatabase: async () => ({
        get: async (sql: string) => (sql.includes('FROM sync_outbox') ? db.outbox : db.lesson),
        close: async () => undefined,
    }),
}));

const { teamSendStateOf } = await import('./team-outbox.js');

describe('teamSendStateOf', () => {
    beforeEach(() => { db.outbox = undefined; db.lesson = undefined; });

    it('is sent only when the entry synced without an error', async () => {
        db.outbox = { synced_at: 1, last_error: null };
        expect(await teamSendStateOf('l1')).toEqual({ state: 'sent' });
    });

    it('is held, with the reason, while the entry waits', async () => {
        db.outbox = { synced_at: null, last_error: 'held: repository forge.example.com/a/b is not one of the team\'s repositories' };
        expect(await teamSendStateOf('l1')).toEqual({ state: 'held', reason: "repository forge.example.com/a/b is not one of the team's repositories" });
    });

    it('is not sent when the entry was set aside or refused', async () => {
        db.outbox = { synced_at: 1, last_error: 'not sent: repository unknown on this machine' };
        expect(await teamSendStateOf('l1')).toEqual({ state: 'not sent', reason: 'repository unknown on this machine' });
        db.outbox = { synced_at: 1, last_error: 'refused by the team database: permission denied' };
        expect(await teamSendStateOf('l1')).toEqual({ state: 'not sent', reason: 'refused by the team database: permission denied' });
    });

    it('is queued while the entry has not been tried, keeping a transient error', async () => {
        db.outbox = { synced_at: null, last_error: null };
        expect(await teamSendStateOf('l1')).toEqual({ state: 'queued' });
        db.outbox = { synced_at: null, last_error: 'connect ECONNREFUSED' };
        expect(await teamSendStateOf('l1')).toEqual({ state: 'queued', reason: 'connect ECONNREFUSED' });
    });

    it('is already in the team database when it was pulled from there, never queued here', async () => {
        db.lesson = { team_id: 'web' };
        expect(await teamSendStateOf('l1')).toEqual({ state: 'in the team database' });
        db.lesson = { team_id: null };
        expect(await teamSendStateOf('l1')).toEqual({ state: 'queued' });
    });
});
