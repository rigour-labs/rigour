/**
 * Against a real PostgreSQL, when RIGOUR_TEST_DATABASE_URL names a database an administrator owns (skipped otherwise):
 * the team database's guards on lessons hold against what a login can do on its own. An operator planted in a schema
 * the login may create in never stands in for pg_catalog's inside Rigour's functions; a member's drop goes through the
 * client's own sync; an sme never proposes in a teammate's name; a login that may not read pg_policies still syncs; a
 * shared copy an older client made, which the database refused, stops being served; and a login that is not a member
 * cannot run Rigour's functions. Each person is a process with its own local store and a login of its own.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.RIGOUR_TEST_DATABASE_URL;
const DATABASE = `rigour_guards_${process.pid}`;
const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'storage');
const distModule = (name: string) => JSON.stringify(pathToFileURL(path.join(dist, `${name}.js`)).href);

describe.skipIf(!URL || !fs.existsSync(dist))('the guards on team lessons, on a real PostgreSQL', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lesson-guards-'));
    const teamUrl = () => { const url = new globalThis.URL(URL!); url.pathname = `/${DATABASE}`; return url.toString(); };
    const pg = async (connectionString: string) => new (await import('pg')).Pool({ connectionString });
    const person = (name: string, actor: string) => {
        const repo = path.join(root, `${name}-repo`);
        fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
        fs.writeFileSync(path.join(repo, '.git', 'config'), '[remote "origin"]\n\turl = https://forge.example.com/example-org/widgets.git\n');
        const login = `rigour_guards_${name}_${process.pid}`;
        const url = () => { const u = new globalThis.URL(teamUrl()); u.username = login; u.password = 'synthetic-login-pass'; return u.toString(); };
        return { repo, home: path.join(root, `${name}-home`), actor, login, url };
    };
    const sme = person('s', 'reviewer-s');
    const member = person('b', 'dev-b');
    const outsider = person('x', 'nobody');
    type Person = typeof sme;

    /** Runs `body` as `who`, in a process of its own, with the dist modules `lessons`, `teamStore`, `localDb` and `encryption`. */
    const run = (who: Person, body: string) => new Promise<any>((resolve, reject) => {
        const script = `const lessons = await import(${distModule('lessons')});
const teamStore = await import(${distModule('team-store')});
const localDb = await import(${distModule('db')});
const encryption = await import(${distModule('local-encryption')});
const repo = ${JSON.stringify(who.repo)};
console.log(JSON.stringify(await (${body})()));`;
        const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
            env: {
                ...process.env, RIGOUR_HOME: who.home, RIGOUR_TELEMETRY: '0', RIGOUR_TEAM_DATABASE_URL: who.url(),
                RIGOUR_ORGANIZATION_ID: 'example-org', RIGOUR_TEAM_ID: 'web', RIGOUR_ACTOR_ID: who.actor,
                RIGOUR_TEAM_REPOSITORIES: 'forge.example.com/example-org/widgets',
            },
        });
        let out = '';
        let err = '';
        child.stdout.on('data', d => { out += d; });
        child.stderr.on('data', d => { err += d; });
        child.on('close', code => (code === 0 ? resolve(JSON.parse(out.trim().split('\n').pop() ?? 'null')) : reject(new Error(err || out))));
    });
    const admin = async <T>(body: (pool: any) => Promise<T>): Promise<T> => {
        const pool = await pg(teamUrl());
        try { return await body(pool); } finally { await pool.end(); }
    };
    const promoted = (id: string, actor: string) => admin(team => team.query(`INSERT INTO rigour.lessons (id, organization_id, team_id, repository_id, actor_id, visibility, state, kind, subject, evidence_json, confidence, source, created_at, updated_at)
        VALUES ($1, 'example-org', 'web', 'r', $2, 'team', 'promoted', 'memory', 'owner-rule: as the owner wrote it', '{"key": "owner-rule"}', 0.9, 'published:c', $3, $3)`, [id, actor, Date.now()]));

    beforeAll(async () => {
        const server = await pg(URL!);
        await server.query(`DROP DATABASE IF EXISTS ${DATABASE}`);
        await server.query(`CREATE DATABASE ${DATABASE}`);
        for (const who of [sme, member, outsider]) {
            await server.query(`DROP ROLE IF EXISTS ${who.login}`).catch(() => undefined);
            await server.query(`CREATE ROLE ${who.login} LOGIN PASSWORD 'synthetic-login-pass'`);
        }
        await server.end();
        const { initializeTeamSchema } = await import('./team-store.js');
        await initializeTeamSchema(teamUrl());
        await admin(async team => {
            for (const [who, role] of [[sme, 'sme'], [member, 'member']] as const) {
                await team.query('INSERT INTO rigour.memberships (db_role, organization_id, team_id, actor_id, role) VALUES ($1, $2, $3, $4, $5)', [who.login, 'example-org', 'web', who.actor, role]);
            }
            await team.query(`INSERT INTO rigour.memberships (db_role, organization_id, team_id, actor_id, role) VALUES (current_user, 'example-org', 'web', 'owner-o', 'owner')`);
            await team.query(`GRANT USAGE ON SCHEMA rigour TO ${outsider.login}`);
        });
        await initializeTeamSchema(teamUrl()); // grants each member login its tables and functions
    });

    afterAll(async () => {
        const server = await pg(URL!);
        await server.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
        for (const who of [sme, member, outsider]) await server.query(`DROP ROLE IF EXISTS ${who.login}`);
        await server.end();
        fs.rmSync(root, { recursive: true, force: true });
    });

    it("never lets an operator an sme planted stand in for pg_catalog's inside the lesson guard", async () => {
        await promoted('lesson-owner', 'owner-o');
        await admin(team => team.query(`GRANT CREATE ON SCHEMA public TO ${sme.login}`)); // the default before PostgreSQL 15
        const client = new (await import('pg')).Client({ connectionString: sme.url() });
        await client.connect();
        try {
            await client.query(`CREATE FUNCTION public.always_equal(text, text) RETURNS boolean LANGUAGE sql AS 'SELECT true'`);
            await client.query('CREATE OPERATOR public.= (LEFTARG = text, RIGHTARG = text, FUNCTION = public.always_equal)');
            await client.query('SET search_path = public, pg_catalog');
            await expect(client.query(`UPDATE rigour.lessons SET subject = 'owner-rule: rewritten', source = 'forged' WHERE id = 'lesson-owner'`)).rejects.toThrow(/keeps its id, text, author/);
            await client.query(`INSERT INTO rigour.lessons (id, organization_id, team_id, repository_id, actor_id, visibility, state, kind, subject, evidence_json, confidence, source, created_at, updated_at)
                VALUES ('lesson-forged', 'example-org', 'web', 'r', 'owner-o', 'team', 'promoted', 'memory', 'forged: x', '{}', 0.9, 'published:z', 1, 1)`);
        } finally {
            await client.end();
        }
        const rows = await admin(async team => (await team.query(`SELECT id, subject, decided_by FROM rigour.lessons WHERE id IN ('lesson-owner', 'lesson-forged') ORDER BY id`)).rows);
        expect(rows).toEqual([
            { id: 'lesson-forged', subject: 'forged: x', decided_by: 'reviewer-s' },
            { id: 'lesson-owner', subject: 'owner-rule: as the owner wrote it', decided_by: 'owner-o' },
        ]);
    }, 120_000);

    it("sends a member's drop through the client's own sync, and never a dropped shared copy of theirs", async () => {
        const sent = await run(member, `async () => {
            const id = await lessons.shareMemoryLesson(repo, 'naming', 'Hooks are named useX.');
            await teamStore.syncTeamOutbox({ cwd: repo });
            await lessons.transitionLesson(id, 'rejected', { queueSync: true });
            await teamStore.syncTeamOutbox({ cwd: repo });
            const outbox = await import(${distModule('team-outbox')});
            return outbox.teamSendStateOf(id);
        }`);
        expect(sent).toEqual({ state: 'sent' });
        expect(await admin(async team => (await team.query(`SELECT state, decided_by FROM rigour.lessons WHERE subject = 'naming: Hooks are named useX.'`)).rows)).toEqual([{ state: 'rejected', decided_by: 'dev-b' }]);
        const pool = await pg(member.url());
        try {
            await expect(pool.query(`INSERT INTO rigour.lessons (id, organization_id, team_id, repository_id, actor_id, visibility, state, kind, subject, evidence_json, confidence, source, created_at, updated_at)
                VALUES ('lesson-planted', 'example-org', 'web', 'r', 'dev-b', 'team', 'rejected', 'memory', 'x: y', '{}', 0.5, 'published:someone', 1, 1)`)).rejects.toThrow(/row-level security/);
        } finally {
            await pool.end();
        }
    }, 120_000);

    it("never lets an sme propose a candidate in a teammate's name", async () => {
        const pool = await pg(sme.url());
        try {
            await expect(pool.query(`INSERT INTO rigour.lessons (id, organization_id, team_id, repository_id, actor_id, visibility, state, kind, subject, evidence_json, confidence, source, created_at, updated_at)
                VALUES ('lesson-as-b', 'example-org', 'web', 'r', 'dev-b', 'team', 'candidate', 'memory', 'x: y', '{}', 0.5, 'rigour_remember', 1, 1)`)).rejects.toThrow(/row-level security/);
        } finally {
            await pool.end();
        }
    }, 120_000);

    it('syncs a login that may not read pg_policies, and says when it cannot verify the rules', async () => {
        const doctor = `async () => { await teamStore.syncTeamOutbox({ cwd: repo }); const d = await teamStore.doctorTeamConnection(); return [d.connectivity, d.candidateReview, d.message]; }`;
        await admin(team => team.query('REVOKE SELECT ON pg_catalog.pg_policies FROM PUBLIC'));
        try {
            expect((await run(member, doctor)).slice(0, 2)).toEqual(['online', 'ready']);
            await admin(team => team.query(`REVOKE EXECUTE ON FUNCTION rigour.candidate_review_state() FROM ${member.login}`));
            const [connectivity, state, message] = await run(member, doctor);
            expect([connectivity, state]).toEqual(['online', 'rules not verified']);
            expect(message).toContain('could not be verified');
        } finally {
            await admin(team => team.query('GRANT SELECT ON pg_catalog.pg_policies TO PUBLIC'));
            const { initializeTeamSchema } = await import('./team-store.js');
            await initializeTeamSchema(teamUrl());
        }
    }, 120_000);

    it('stops serving a shared copy an older client made for a member, which the team database refused', async () => {
        const result = await run(member, `async () => {
            const id = await lessons.shareMemoryLesson(repo, 'legacy', 'Shared by an older client.');
            await teamStore.syncTeamOutbox({ cwd: repo });
            // What Rigour 7.0.10 left when its member clicked Share: a promoted copy here, its send refused.
            const db = await localDb.openDatabase();
            const now = Date.now();
            await db.run(\`INSERT INTO lessons (id, repository_id, actor_id, team_id, visibility, state, kind, subject, evidence_json, confidence, source, created_at, updated_at)
                VALUES ('lesson-legacy-copy', ?, 'dev-b', 'web', 'team', 'promoted', 'memory', 'legacy: Shared by an older client.', ?, 0.5, ?, ?, ?)\`,
                await lessons.getRepositoryId(repo), await encryption.encryptLocalPayload({ key: 'legacy', value: 'Shared by an older client.' }), 'published:' + id, now, now);
            await db.run(\`INSERT INTO sync_outbox (id, operation, entity_type, entity_id, payload_json, created_at, synced_at, last_error)
                VALUES ('outbox-legacy', 'upsert', 'lesson', 'lesson-legacy-copy', ?, ?, ?, 'refused by the team database: new row violates row-level security policy for table "lessons"')\`,
                await encryption.encryptLocalPayload({}), now, now);
            await db.close();
            const served = async () => (await lessons.getApplicableLessons(repo)).lessons.map(l => l.id).filter(l => l === 'lesson-legacy-copy');
            const before = await served();
            await teamStore.syncTeamOutbox({ cwd: repo });
            const listed = (await lessons.listKnowledgeLessons(repo)).filter(l => l.subject.startsWith('legacy:')).map(l => [l.id === id ? 'candidate row' : l.id, l.state]);
            return { before, after: await served(), listed };
        }`);
        expect(result).toEqual({ before: ['lesson-legacy-copy'], after: [], listed: [['candidate row', 'candidate']] });
    }, 120_000);

    it("keeps Rigour's functions from a login that is not a member, and lets a member run the ones a sync calls", async () => {
        const call = async (who: Person, sql: string) => {
            const pool = await pg(who.url());
            try {
                return (await pool.query(sql)).rows[0];
            } finally {
                await pool.end();
            }
        };
        await expect(call(outsider, `SELECT rigour.team_actor('example-org', 'web', 'dev-b') AS answer`)).rejects.toThrow(/permission denied for function team_actor/);
        expect(await call(member, `SELECT rigour.team_actor('example-org', 'web', 'dev-b') AS answer, rigour.candidate_review_state() AS state`)).toEqual({ answer: true, state: 'ready' });
    }, 120_000);
});
