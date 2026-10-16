import { describe, expect, it } from 'vitest';
import { retireUnshared } from './team-reconcile.js';

describe('shared lessons the team database no longer shares', () => {
    it('stops serving the shared lessons the team database no longer shares, and leaves the rest', async () => {
        const updates: string[] = [];
        const db = {
            all: async () => [{ id: 'still-shared' }, { id: 'taken-back' }],
            run: async (_sql: string, id: unknown) => { updates.push(String(id)); },
        };
        const pool = { query: async (_sql: string, params?: unknown[]) => ({ rows: (params![0] as string[]).filter(id => id === 'still-shared').map(id => ({ id })) }) };
        expect(await retireUnshared(pool, db, 'web')).toBe(1);
        expect(updates).toEqual(['taken-back']);
    });
});
