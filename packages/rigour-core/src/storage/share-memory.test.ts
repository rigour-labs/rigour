import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ rows: [] as any[], outbox: 0, reset() { this.rows = []; this.outbox = 0; } }));

vi.mock('./db.js', () => {
    const store = {
        run: async (sql: string, ...params: any[]) => {
            if (sql.includes('INSERT INTO lessons')) db.rows.push({ id: params[0], visibility: 'team', state: 'candidate', kind: 'memory', subject: params[4] });
            if (sql.includes('INSERT INTO sync_outbox')) db.outbox++;
            return { changes: 1, lastID: 0 };
        },
        get: async (sql: string, ...params: any[]) => (sql.includes("kind = 'memory'") ? db.rows.find(r => r.subject === params[1]) : undefined),
        all: async () => [],
        exec: async () => undefined,
        close: async () => undefined,
    };
    return { openDatabase: async () => store };
});
vi.mock('./local-encryption.js', () => ({ encryptLocalPayload: async (v: unknown) => JSON.stringify(v), decryptLocalPayload: async (v: string) => JSON.parse(v) }));
vi.mock('./team-store.js', () => ({ loadTeamConfiguration: async () => null }));

const { shareMemoryLesson } = await import('./lessons.js');

beforeEach(() => db.reset());

describe('shareMemoryLesson', () => {
    it('stores a team candidate of kind memory, once per memory', async () => {
        const first = await shareMemoryLesson(process.cwd(), 'retries', 'Use withRetry from lib/net.');
        const again = await shareMemoryLesson(process.cwd(), 'retries', 'Use withRetry from lib/net.');
        expect(first).toBe(again);
        expect(db.rows).toEqual([{ id: first, visibility: 'team', state: 'candidate', kind: 'memory', subject: 'retries: Use withRetry from lib/net.' }]);
    });

    it('queues nothing for sync until team mode is configured', async () => {
        await shareMemoryLesson(process.cwd(), 'naming', 'Hooks are named useX.');
        expect(db.outbox).toBe(0);
    });
});
