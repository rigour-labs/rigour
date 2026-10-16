import { describe, expect, it } from 'vitest';
import { retireUnshared } from './team-reconcile.js';

describe('shared lessons the team database no longer shares, or never took', () => {
    it('retires those it took and no longer shares, removes copies it never took, and marks those it has', async () => {
        const writes: string[] = [];
        const db = {
            all: async () => [
                { id: 'still-shared', on_server: 1, source: 'published:a' },
                { id: 'taken-back', on_server: 1, source: 'published:b' },
                { id: 'refused-copy', on_server: 0, source: 'published:c' },
                { id: 'there-after-all', on_server: 0, source: 'published:d' },
            ],
            run: async (sql: string, id: unknown) => { writes.push(`${sql.split(' ')[0]} ${String(id)}`); },
        };
        const shared = new Set(['still-shared', 'there-after-all']);
        const pool = { query: async (_sql: string, params?: unknown[]) => ({ rows: (params![0] as string[]).filter(id => shared.has(id)).map(id => ({ id })) }) };
        expect(await retireUnshared(pool, db, { organizationId: 'acme', teamId: 'web', actorId: 'dev-a' })).toBe(2);
        expect(writes).toEqual(['UPDATE taken-back', 'DELETE refused-copy', 'UPDATE there-after-all']);
    });
});
