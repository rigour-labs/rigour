/**
 * Against a real PostgreSQL, when RIGOUR_TEST_DATABASE_URL names a database an administrator owns (skipped otherwise):
 * an sme sees every teammate's team candidates and shares or drops them, while a member sees only the team's promoted
 * lessons and their own, and nobody but its author reads a personal lesson. Each person is a machine of their own (a
 * process with its own local store) and a login of their own, so the row-level security policies decide, as in use.
 * The last case puts back the policies from before candidate review and checks the same clients still sync.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.RIGOUR_TEST_DATABASE_URL;
const DATABASE = `rigour_sme_${process.pid}`;
const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'storage');
const PASSWORD = 'synthetic-login-pass';

/** The lessons policies as they were before candidate review (candidate_review_version), for the old-schema case. */
const OLD_POLICIES = `
DROP POLICY IF EXISTS lessons_read ON rigour.lessons;
CREATE POLICY lessons_read ON rigour.lessons FOR SELECT USING (EXISTS (
    SELECT 1 FROM rigour.memberships membership
    WHERE membership.db_role = current_user AND membership.organization_id = lessons.organization_id AND membership.team_id = lessons.team_id
      AND ((lessons.visibility = 'team' AND lessons.state = 'promoted') OR membership.actor_id = lessons.actor_id)));
DROP POLICY IF EXISTS lessons_write ON rigour.lessons;
CREATE POLICY lessons_write ON rigour.lessons FOR ALL USING (EXISTS (
    SELECT 1 FROM rigour.memberships membership
    WHERE membership.db_role = current_user AND membership.organization_id = lessons.organization_id AND membership.team_id = lessons.team_id
      AND membership.actor_id = lessons.actor_id AND (lessons.visibility = 'personal' OR membership.role IN ('sme', 'owner'))))
WITH CHECK (EXISTS (
    SELECT 1 FROM rigour.memberships membership
    WHERE membership.db_role = current_user AND membership.organization_id = lessons.organization_id AND membership.team_id = lessons.team_id
      AND membership.actor_id = lessons.actor_id AND (lessons.visibility = 'personal' OR membership.role IN ('sme', 'owner'))));
DELETE FROM rigour.meta WHERE key = 'candidate_review_version';
`;

describe.skipIf(!URL || !fs.existsSync(dist))('an sme deciding on teammates\' candidates, on a real PostgreSQL', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sme-candidates-'));
    const teamUrl = () => { const url = new globalThis.URL(URL!); url.pathname = `/${DATABASE}`; return url.toString(); };
    const pg = async (connectionString: string) => new (await import('pg')).Pool({ connectionString });
    const person = (name: string, actor: string, role: 'member' | 'sme') => {
        const repo = path.join(root, `${name}-repo`);
        fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
        fs.writeFileSync(path.join(repo, '.git', 'config'), '[remote "origin"]\n\turl = https://forge.example.com/example-org/widgets.git\n');
        const login = `rigour_sme_${name}_${process.pid}`;
        const url = () => { const u = new globalThis.URL(teamUrl()); u.username = login; u.password = PASSWORD; return u.toString(); };
        return { repo, home: path.join(root, `${name}-home`), actor, role, login, url };
    };
    const author = person('a', 'dev-a', 'sme');
    const sme = person('s', 'reviewer-s', 'sme');
    const member = person('b', 'dev-b', 'member');
    type Person = typeof author;

    /** Runs `body` (an async function of the dist modules `lessons` and `teamStore`) as `who`, in a process of its own. */
    const run = (who: Person, body: string) => new Promise<any>((resolve, reject) => {
        const script = `const lessons = await import(${JSON.stringify(pathToFileURL(path.join(dist, 'lessons.js')).href)});
const teamStore = await import(${JSON.stringify(pathToFileURL(path.join(dist, 'team-store.js')).href)});
const repo = ${JSON.stringify(who.repo)};
const memories = async () => (await lessons.listKnowledgeLessons(repo)).filter(l => l.kind === 'memory');
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
    const sync = (who: Person) => run(who, 'async () => teamStore.syncTeamOutbox({ cwd: repo })');
    /** What `who` reads of the team's lessons through their own login: row-level security applies. */
    const reads = async (who: Person) => {
        const pool = await pg(who.url());
        try {
            return (await pool.query('SELECT actor_id, visibility, state, subject FROM rigour.lessons ORDER BY subject, state')).rows.map(r => [r.actor_id, r.visibility, r.state, r.subject]);
        } finally {
            await pool.end();
        }
    };
    const admin = async <T>(body: (pool: any) => Promise<T>): Promise<T> => {
        const pool = await pg(teamUrl());
        try { return await body(pool); } finally { await pool.end(); }
    };

    beforeAll(async () => {
        const server = await pg(URL!);
        await server.query(`DROP DATABASE IF EXISTS ${DATABASE}`);
        await server.query(`CREATE DATABASE ${DATABASE}`);
        for (const who of [author, sme, member]) {
            await server.query(`DROP ROLE IF EXISTS ${who.login}`);
            await server.query(`CREATE ROLE ${who.login} LOGIN PASSWORD '${PASSWORD}'`);
        }
        await server.end();
        const { initializeTeamSchema } = await import('./team-store.js');
        await initializeTeamSchema(teamUrl());
        await admin(async team => {
            for (const who of [author, sme, member]) {
                await team.query('INSERT INTO rigour.memberships (db_role, organization_id, team_id, actor_id, role) VALUES ($1, $2, $3, $4, $5)', [who.login, 'example-org', 'web', who.actor, who.role]);
            }
        });
        await initializeTeamSchema(teamUrl()); // grants each login its tables
    });

    afterAll(async () => {
        const server = await pg(URL!);
        await server.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
        for (const who of [author, sme, member]) await server.query(`DROP ROLE IF EXISTS ${who.login}`);
        await server.end();
        fs.rmSync(root, { recursive: true, force: true });
    });

    it("shows a teammate's candidates to an sme, never to a member, and nobody else their personal lesson", async () => {
        await run(author, `async () => {
            await lessons.shareMemoryLesson(repo, 'retries', 'Use withRetry from lib/net.');
            await lessons.shareMemoryLesson(repo, 'paging', 'Use keyset pagination.');
            return teamStore.syncTeamOutbox({ cwd: repo });
        }`);
        // A personal lesson, written through the author's own login as a sync with --sync-personal writes it.
        const own = await pg(author.url());
        await own.query(`INSERT INTO rigour.lessons (id, organization_id, team_id, repository_id, actor_id, visibility, state, kind, subject, evidence_json, confidence, source, created_at, updated_at)
            VALUES ('lesson-personal-a', 'example-org', 'web', 'r', 'dev-a', 'personal', 'candidate', 'fix', 'Personal: close the handle.', '{}', 0.4, 'agent-fix', 1, 1)`);
        await own.end();

        await sync(member);
        expect(await run(member, 'async () => (await memories()).map(l => l.subject)')).toEqual([]);
        expect(await reads(member)).toEqual([]);

        await sync(sme);
        expect(await run(sme, 'async () => (await memories()).map(l => [l.subject, l.state, l.actorId]).sort()')).toEqual([
            ['paging: Use keyset pagination.', 'candidate', 'dev-a'],
            ['retries: Use withRetry from lib/net.', 'candidate', 'dev-a'],
        ]);
        expect((await reads(sme)).map(row => row[3])).not.toContain('Personal: close the handle.');
        // Pulled to decide on, never served: an agent of the sme is not given a teammate's candidate.
        expect(await run(sme, 'async () => (await lessons.getApplicableLessons(repo)).lessons.length')).toBe(0);
    }, 120_000);

    it('shares one under its author\'s actor and drops the other, and the drop survives the next pull', async () => {
        await run(sme, `async () => {
            const listed = await memories();
            await lessons.transitionLesson(listed.find(l => l.subject.startsWith('retries:')).id, 'promoted', { visibility: 'team', queueSync: true });
            await lessons.transitionLesson(listed.find(l => l.subject.startsWith('paging:')).id, 'rejected', { queueSync: true });
            return teamStore.syncTeamOutbox({ cwd: repo });
        }`);
        const rows = await admin(async team => (await team.query(`SELECT actor_id, visibility, state, subject, evidence_json->>'publishedBy' AS published_by FROM rigour.lessons WHERE kind = 'memory' ORDER BY subject, state`)).rows);
        expect(rows.map((r: any) => [r.actor_id, r.state, r.subject, r.published_by])).toEqual([
            ['dev-a', 'rejected', 'paging: Use keyset pagination.', null],
            ['dev-a', 'candidate', 'retries: Use withRetry from lib/net.', null],
            ['dev-a', 'promoted', 'retries: Use withRetry from lib/net.', 'reviewer-s'],
        ]);

        await sync(sme);
        expect(await run(sme, `async () => (await memories()).filter(l => l.subject.startsWith('paging:')).map(l => l.state)`)).toEqual(['rejected']);
        await sync(member);
        expect(await run(member, 'async () => (await memories()).map(l => [l.subject, l.state])')).toEqual([['retries: Use withRetry from lib/net.', 'promoted']]);
    }, 120_000);

    it('keeps a member from writing a teammate\'s row, or any team row', async () => {
        const pool = await pg(member.url());
        try {
            await expect(pool.query(`UPDATE rigour.lessons SET state = 'rejected' WHERE visibility = 'team'`)).resolves.toMatchObject({ rowCount: 0 });
            await expect(pool.query(`INSERT INTO rigour.lessons (id, organization_id, team_id, repository_id, actor_id, visibility, state, kind, subject, evidence_json, confidence, source, created_at, updated_at)
                VALUES ('lesson-b', 'example-org', 'web', 'r', 'dev-a', 'team', 'candidate', 'memory', 'x: y', '{}', 0.5, 's', 1, 1)`)).rejects.toThrow(/row-level security/);
        } finally {
            await pool.end();
        }
    }, 120_000);

    it('syncs with the same clients on a database with the policies from before candidate review', async () => {
        await admin(team => team.query(OLD_POLICIES));
        await run(author, `async () => {
            await lessons.shareMemoryLesson(repo, 'naming', 'Hooks are named useX.');
            return teamStore.syncTeamOutbox({ cwd: repo });
        }`);
        const result = await sync(sme);
        expect(result).toMatchObject({ synced: 0 });
        expect(await run(sme, `async () => (await memories()).map(l => l.subject)`)).not.toContain('naming: Hooks are named useX.');
        expect(await reads(sme)).toEqual([['dev-a', 'team', 'promoted', 'retries: Use withRetry from lib/net.']]);
        await sync(member);
        expect(await run(member, 'async () => (await memories()).map(l => [l.subject, l.state])')).toEqual([['retries: Use withRetry from lib/net.', 'promoted']]);
    }, 120_000);
});
