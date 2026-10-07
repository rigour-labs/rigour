import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** The outbox and repositories a machine holds, and what reached the team database. */
const state = vi.hoisted(() => ({ outbox: [] as any[], repos: new Map<string, string>(), sent: [] as string[], refuse: new Set<string>(), meta: new Map<string, string>(), remote: [] as any[], since: [] as number[] }));

vi.mock('./db.js', () => ({
    openDatabase: async () => ({
        all: async () => state.outbox.filter(o => o.synced_at == null),
        get: async (sql: string, id: string) => sql.includes('FROM meta')
            ? (state.meta.has(id) ? { value: state.meta.get(id) } : undefined)
            : (state.repos.has(id) ? { canonical_uri: state.repos.get(id) } : undefined),
        run: async (sql: string, ...p: any[]) => {
            if (sql.startsWith('INSERT INTO meta')) state.meta.set(p[0], p[1]);
            if (sql.startsWith('UPDATE sync_outbox SET synced_at')) {
                const id = p.at(-1);
                Object.assign(state.outbox.find(o => o.id === id) ?? {}, { synced_at: p[0], last_error: p.length === 3 ? p[1] : null });
            }
            return { changes: 1 };
        },
        close: async () => undefined,
    }),
}));
vi.mock('./local-encryption.js', () => ({ encryptLocalPayload: async (v: unknown) => JSON.stringify(v), decryptLocalPayload: async (v: string) => JSON.parse(v) }));
vi.mock('pg', () => ({
    Pool: class {
        async query(sql: string, params: any[]) {
            if (sql.includes('INSERT INTO rigour.lessons')) {
                if (state.refuse.has(params[0])) throw Object.assign(new Error('new row violates row-level security policy for table "lessons"'), { code: '42501' });
                state.sent.push(params[0]);
                return { rowCount: 1, rows: [] };
            }
            if (sql.includes('FROM rigour.lessons')) {
                state.since.push(params[3]);
                return { rowCount: 0, rows: state.remote.filter(row => row.updated_at > params[3]) };
            }
            return { rowCount: 1, rows: [] };
        }
        async end() { /* nothing to close */ }
    },
}));

const { syncTeamOutbox } = await import('./team-store.js');

const queue = (id: string, repositoryId: string, visibility: string) =>
    state.outbox.push({ id: `outbox-${id}`, payload_json: JSON.stringify({ id, repositoryId, visibility, evidence: {} }), synced_at: null });

const TEAM_ENV = {
    RIGOUR_ORGANIZATION_ID: 'acme', RIGOUR_TEAM_ID: 'web', RIGOUR_ACTOR_ID: 'dev-1',
    RIGOUR_TEAM_DATABASE_URL: 'postgresql://localhost/rigour', RIGOUR_TEAM_REPOSITORIES: 'github.com/acme/*',
};
const saved = { ...process.env };

beforeEach(() => {
    Object.assign(process.env, TEAM_ENV);
    delete process.env.RIGOUR_TEAM_SYNC_PERSONAL;
    state.outbox = []; state.sent = []; state.refuse = new Set(); state.meta = new Map(); state.remote = []; state.since = [];
    state.repos = new Map([['r-team', 'https://github.com/acme/web'], ['r-other', 'https://github.com/other-org/app']]);
    queue('l-team', 'r-team', 'team');
    queue('l-other', 'r-other', 'team');
    queue('l-personal', 'r-team', 'personal');
    queue('l-unknown', 'r-gone', 'team');
});
afterEach(() => { process.env = { ...saved }; });

describe('team sync scope', () => {
    it("sends only the team's own shared lessons and says what it kept back", async () => {
        expect(await syncTeamOutbox({ dryRun: true })).toMatchObject({ pending: 1, withheld: 3 });
        expect(state.sent).toEqual([]);

        const result = await syncTeamOutbox();
        expect(result).toMatchObject({ synced: 1, withheld: 3 });
        expect(state.sent).toEqual(['l-team']);
        const reasons = Object.fromEntries(state.outbox.map(o => [o.id, o.last_error]));
        expect(reasons['outbox-l-other']).toContain('github.com/other-org/app');
        expect(reasons['outbox-l-personal']).toContain('personal lesson');
        expect(reasons['outbox-l-unknown']).toContain('repository unknown');
        expect(await syncTeamOutbox({ dryRun: true })).toMatchObject({ pending: 0, withheld: 0 }); // never retried
    });

    it('sets aside a lesson the database refuses and sends the rest of the queue', async () => {
        state.outbox = [];
        queue('l-refused', 'r-team', 'team'); // queued first: it must not hold back what comes after
        queue('l-team', 'r-team', 'team');
        state.refuse.add('l-refused');

        expect(await syncTeamOutbox()).toMatchObject({ synced: 1 });
        expect(state.sent).toEqual(['l-team']);
        expect(state.outbox.find(o => o.id === 'outbox-l-refused').last_error).toContain('refused by the team database: new row violates row-level security');
        expect(await syncTeamOutbox({ dryRun: true })).toMatchObject({ pending: 0 }); // not tried again
    });

    it('pulls only what changed since the last pull, re-reading a margin for slow clocks', async () => {
        const lesson = (id: string, updated: number) => ({ id, repository_id: 'r-team', actor_id: 'dev-2', team_id: 'web', visibility: 'team', state: 'promoted', kind: 'k', subject: 's', evidence_json: {}, confidence: 1, source: 'x', supersedes_id: null, created_at: updated, updated_at: updated });
        const HOUR = 3_600_000;
        state.remote = [lesson('a', 10 * HOUR), lesson('b', 20 * HOUR)];
        expect(await syncTeamOutbox()).toMatchObject({ pulled: 2 });
        expect(state.since).toEqual([0]); // the first pull reads everything

        expect(await syncTeamOutbox()).toMatchObject({ pulled: 1 }); // only b, inside the 15-minute margin
        expect(state.since[1]).toBe(20 * HOUR - 15 * 60_000);
    });

    it('sends nothing when the team lists no repositories', async () => {
        delete process.env.RIGOUR_TEAM_REPOSITORIES;
        expect(await syncTeamOutbox({ dryRun: true })).toMatchObject({ pending: 0, withheld: 4 });
    });
});
