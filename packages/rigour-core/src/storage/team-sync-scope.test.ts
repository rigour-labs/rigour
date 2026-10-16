import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** The outbox and repositories a machine holds, and what reached the team database. */
const state = vi.hoisted(() => ({ outbox: [] as any[], repos: new Map<string, string>(), sent: [] as string[], refuse: new Set<string>(), noGrant: false, meta: new Map<string, string>(), remote: [] as any[], since: [] as number[] }));

vi.mock('./db.js', () => ({
    openDatabase: async () => ({
        // As QUEUED in team-outbox.ts: unsent, or set aside by an earlier version for a repository missing from the team's list.
        all: async () => state.outbox.filter(o => o.synced_at == null || (/^not sent: repository /.test(o.last_error) && !/^not sent: repository unknown/.test(o.last_error))),
        get: async (sql: string, id: string) => sql.includes('FROM meta')
            ? (state.meta.has(id) ? { value: state.meta.get(id) } : undefined)
            : (state.repos.has(id) ? { canonical_uri: state.repos.get(id) } : undefined),
        run: async (sql: string, ...p: any[]) => {
            if (sql.startsWith('INSERT INTO meta')) state.meta.set(p[0], p[1]);
            if (sql.startsWith('UPDATE sync_outbox SET synced_at = NULL')) Object.assign(state.outbox.find(o => o.id === p[1]) ?? {}, { synced_at: null, last_error: p[0] });
            else if (sql.startsWith('UPDATE sync_outbox SET synced_at')) {
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
                if (state.noGrant) throw Object.assign(new Error('permission denied for table lessons'), { code: '42501' });
                if (state.refuse.has(params[0])) throw Object.assign(new Error('new row violates row-level security policy for table "lessons"'), { code: '42501' });
                state.sent.push(params[0]);
                return { rowCount: 1, rows: [] };
            }
            if (sql.includes('id = ANY')) return { rowCount: 0, rows: [] }; // which held shared lessons are still shared
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
/** A folder with no git: review decisions are held back before any query. */
const NO_GIT = fs.mkdtempSync(path.join(os.tmpdir(), 'team-sync-'));

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
    state.outbox = []; state.sent = []; state.refuse = new Set(); state.noGrant = false; state.meta = new Map(); state.remote = []; state.since = [];
    state.repos = new Map([['r-team', 'https://github.com/acme/web'], ['r-other', 'https://github.com/other-org/app']]);
    queue('l-team', 'r-team', 'team');
    queue('l-other', 'r-other', 'team');
    queue('l-personal', 'r-team', 'personal');
    queue('l-unknown', 'r-gone', 'team');
});
afterEach(() => { process.env = { ...saved }; });
afterAll(() => fs.rmSync(NO_GIT, { recursive: true, force: true }));

describe('team sync scope', () => {
    it("sends only the team's own shared lessons and says what it held and kept back", async () => {
        expect(await syncTeamOutbox({ dryRun: true, cwd: NO_GIT })).toMatchObject({ pending: 1, held: 1, withheld: 2 });
        expect(state.sent).toEqual([]);

        const result = await syncTeamOutbox({ cwd: NO_GIT });
        expect(result).toMatchObject({ synced: 1, held: 1, withheld: 2, decisions: { sent: 0, held: 'repository has no origin remote' } });
        expect(result.heldBecause).toEqual(["repository github.com/other-org/app is not one of the team's repositories"]);
        expect(state.sent).toEqual(['l-team']);
        const row = (id: string) => state.outbox.find(o => o.id === `outbox-${id}`);
        expect(row('l-other')).toMatchObject({ synced_at: null, last_error: "held: repository github.com/other-org/app is not one of the team's repositories" });
        expect(row('l-personal').last_error).toContain('personal lesson');
        expect(row('l-unknown').last_error).toContain('repository unknown');
        // The held lesson stays queued; personal and unknown ones are not tried again.
        expect(await syncTeamOutbox({ dryRun: true, cwd: NO_GIT })).toMatchObject({ pending: 0, held: 1, withheld: 0 });
    });

    it('sends a held lesson with the first sync after its repository is added to the team', async () => {
        expect(await syncTeamOutbox({ cwd: NO_GIT })).toMatchObject({ synced: 1, held: 1 });
        process.env.RIGOUR_TEAM_REPOSITORIES = 'github.com/acme/*,github.com/other-org/app';
        expect(await syncTeamOutbox({ cwd: NO_GIT })).toMatchObject({ pending: 1, synced: 1, held: 0 });
        expect(state.sent).toEqual(['l-team', 'l-other']);
        expect(state.outbox.find(o => o.id === 'outbox-l-other').last_error).toBeNull();
    });

    it("sends a lesson an earlier version set aside for a repository missing from the team's list, once it is listed", async () => {
        state.outbox = [];
        const setAside = (id: string, repositoryId: string, visibility: string, lastError: string) =>
            state.outbox.push({ id: `outbox-${id}`, payload_json: JSON.stringify({ id, repositoryId, visibility, evidence: {} }), synced_at: 1, last_error: lastError });
        setAside('l-other', 'r-other', 'team', "not sent: repository github.com/other-org/app is not one of the team's repositories");
        setAside('l-unknown', 'r-gone', 'team', 'not sent: repository unknown on this machine');
        setAside('l-personal', 'r-team', 'personal', 'not sent: personal lesson');
        expect(await syncTeamOutbox({ dryRun: true, cwd: NO_GIT })).toMatchObject({ pending: 0, held: 1, withheld: 0 });
        process.env.RIGOUR_TEAM_REPOSITORIES = 'github.com/acme/*,github.com/other-org/app';
        expect(await syncTeamOutbox({ cwd: NO_GIT })).toMatchObject({ synced: 1, held: 0 });
        expect(state.sent).toEqual(['l-other']);
    });

    it('does not let held lessons keep newer ones from being sent', async () => {
        state.outbox = [];
        for (let i = 0; i < 250; i++) queue(`l-held-${i}`, 'r-other', 'team');
        queue('l-team', 'r-team', 'team');
        expect(await syncTeamOutbox({ cwd: NO_GIT })).toMatchObject({ synced: 1, held: 250 });
        expect(state.sent).toEqual(['l-team']);
    });

    it('sets aside a lesson the database refuses and sends the rest of the queue', async () => {
        state.outbox = [];
        queue('l-refused', 'r-team', 'team'); // queued first: it must not hold back what comes after
        queue('l-team', 'r-team', 'team');
        state.refuse.add('l-refused');

        expect(await syncTeamOutbox({ cwd: NO_GIT })).toMatchObject({ synced: 1 });
        expect(state.sent).toEqual(['l-team']);
        expect(state.outbox.find(o => o.id === 'outbox-l-refused').last_error).toContain('refused by the team database: new row violates row-level security');
        expect(await syncTeamOutbox({ dryRun: true, cwd: NO_GIT })).toMatchObject({ pending: 0 }); // not tried again
    });

    it('pulls only what changed since the last pull, re-reading a margin for slow clocks', async () => {
        const lesson = (id: string, updated: number) => ({ id, repository_id: 'r-team', actor_id: 'dev-2', team_id: 'web', visibility: 'team', state: 'promoted', kind: 'k', subject: 's', evidence_json: {}, confidence: 1, source: 'x', supersedes_id: null, created_at: updated, updated_at: updated });
        const HOUR = 3_600_000;
        state.remote = [lesson('a', 10 * HOUR), lesson('b', 20 * HOUR)];
        expect(await syncTeamOutbox({ cwd: NO_GIT })).toMatchObject({ pulled: 2 });
        expect(state.since).toEqual([0]); // the first pull reads everything

        expect(await syncTeamOutbox({ cwd: NO_GIT })).toMatchObject({ pulled: 1 }); // only b, inside the 15-minute margin
        expect(state.since[1]).toBe(20 * HOUR - 15 * 60_000);
    });

    it('stops on a missing grant with one line and the GRANT, and keeps the lesson queued to send once granted', async () => {
        state.noGrant = true;
        await expect(syncTeamOutbox({ cwd: NO_GIT })).rejects.toThrow('your login lacks SELECT, INSERT, UPDATE on rigour.lessons; ask the administrator to run: GRANT SELECT, INSERT, UPDATE ON rigour.lessons TO "<your login>";');
        expect(state.outbox.find(o => o.id === 'outbox-l-team').synced_at).toBeNull();
        state.noGrant = false;
        expect(await syncTeamOutbox({ cwd: NO_GIT })).toMatchObject({ synced: 1 });
    });

    it('sends nothing when the team lists no repositories', async () => {
        delete process.env.RIGOUR_TEAM_REPOSITORIES;
        expect(await syncTeamOutbox({ dryRun: true, cwd: NO_GIT })).toMatchObject({ pending: 0, held: 2, withheld: 2 });
    });
});
