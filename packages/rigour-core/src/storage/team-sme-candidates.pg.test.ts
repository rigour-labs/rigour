/**
 * Against a real PostgreSQL, when RIGOUR_TEST_DATABASE_URL names a database an administrator owns (skipped otherwise):
 * a member proposes team candidates of their own and supersedes them, but never shares, drops or touches another's; an
 * sme sees every member's team candidates and shares or drops them; nobody but its author reads a personal lesson. Each person is a machine of their own (a
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

/** The lessons policies of Rigour 7.0.10 and earlier, as its init-schema creates them. */
const LEGACY_POLICIES = `
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
`;
/** A database as 7.0.10 left it: its policies only, no lesson guard, no candidate rules in meta. */
const OLD_DATABASE = `
DROP POLICY IF EXISTS lessons_read_v2 ON rigour.lessons;
DROP POLICY IF EXISTS lessons_insert_v2 ON rigour.lessons;
DROP POLICY IF EXISTS lessons_update_v2 ON rigour.lessons;
DROP POLICY IF EXISTS lessons_delete_v2 ON rigour.lessons;
DROP TRIGGER IF EXISTS lessons_guard ON rigour.lessons;
${LEGACY_POLICIES}
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
const versions = await import(${JSON.stringify(pathToFileURL(path.join(dist, 'team-memory-versions.js')).href)});
const outbox = await import(${JSON.stringify(pathToFileURL(path.join(dist, 'team-outbox.js')).href)});
const fixes = await import(${JSON.stringify(pathToFileURL(path.join(dist, 'fix-lessons.js')).href)});
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
            await server.query(`DROP ROLE IF EXISTS ${who.login}`).catch(() => undefined);
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
        // DELETE is not among the grants a sync needs; granted here so the policies, not the grants, are what refuse it.
        await admin(team => team.query(`GRANT DELETE ON rigour.lessons TO ${[author, sme, member].map(who => who.login).join(', ')}`));
    });

    afterAll(async () => {
        const server = await pg(URL!);
        await server.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
        for (const who of [author, sme, member]) await server.query(`DROP ROLE IF EXISTS ${who.login}`);
        await server.end();
        fs.rmSync(root, { recursive: true, force: true });
    });

    it("shows every member's candidates to an sme, a member only their own, and nobody else a personal lesson", async () => {
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
        // A member proposes one too: it lands as their own candidate.
        await run(member, `async () => {
            await lessons.shareMemoryLesson(repo, 'timeouts', 'Every outbound call has a timeout.');
            return teamStore.syncTeamOutbox({ cwd: repo });
        }`);

        expect(await run(member, 'async () => (await memories()).map(l => [l.subject, l.state, l.actorId])')).toEqual([['timeouts: Every outbound call has a timeout.', 'candidate', 'dev-b']]);
        expect(await reads(member)).toEqual([['dev-b', 'team', 'candidate', 'timeouts: Every outbound call has a timeout.']]);

        await sync(sme);
        expect(await run(sme, 'async () => (await memories()).map(l => [l.subject, l.state, l.actorId]).sort()')).toEqual([
            ['paging: Use keyset pagination.', 'candidate', 'dev-a'],
            ['retries: Use withRetry from lib/net.', 'candidate', 'dev-a'],
            ['timeouts: Every outbound call has a timeout.', 'candidate', 'dev-b'],
        ]);
        expect((await reads(sme)).map(row => row[3])).not.toContain('Personal: close the handle.');
        // Pulled to decide on, never served: an agent of the sme is not given a teammate's candidate.
        expect(await run(sme, 'async () => (await lessons.getApplicableLessons(repo)).lessons.length')).toBe(0);
    }, 120_000);

    it("shares under each author's actor and drops one, and the drop survives the next pull", async () => {
        await run(sme, `async () => {
            const listed = await memories();
            const find = key => listed.find(l => l.subject.startsWith(key + ':')).id;
            await lessons.transitionLesson(find('retries'), 'promoted', { visibility: 'team', queueSync: true });
            await lessons.transitionLesson(find('timeouts'), 'promoted', { visibility: 'team', queueSync: true });
            await lessons.transitionLesson(find('paging'), 'rejected', { queueSync: true });
            return teamStore.syncTeamOutbox({ cwd: repo });
        }`);
        const rows = await admin(async team => (await team.query(`SELECT actor_id, visibility, state, subject, evidence_json->>'publishedBy' AS published_by FROM rigour.lessons WHERE kind = 'memory' ORDER BY subject, state`)).rows);
        expect(rows.map((r: any) => [r.actor_id, r.state, r.subject, r.published_by])).toEqual([
            ['dev-a', 'rejected', 'paging: Use keyset pagination.', null],
            ['dev-a', 'candidate', 'retries: Use withRetry from lib/net.', null],
            ['dev-a', 'promoted', 'retries: Use withRetry from lib/net.', 'reviewer-s'],
            ['dev-b', 'candidate', 'timeouts: Every outbound call has a timeout.', null],
            ['dev-b', 'promoted', 'timeouts: Every outbound call has a timeout.', 'reviewer-s'],
        ]);

        await sync(sme);
        expect(await run(sme, `async () => (await memories()).filter(l => l.subject.startsWith('paging:')).map(l => l.state)`)).toEqual(['rejected']);
        await sync(member);
        expect(await run(member, `async () => (await memories()).filter(l => l.state === 'promoted').map(l => l.subject).sort()`)).toEqual([
            'retries: Use withRetry from lib/net.', 'timeouts: Every outbound call has a timeout.',
        ]);
    }, 120_000);

    it('lets a member supersede or drop their own candidate, and nothing else: no share, no teammate\'s row, no promoted row', async () => {
        await run(member, `async () => {
            await lessons.shareMemoryLesson(repo, 'logging', 'Log the request id.');
            await teamStore.syncTeamOutbox({ cwd: repo });
            await lessons.shareMemoryLesson(repo, 'logging', 'Log the request id and the tenant.');
            return teamStore.syncTeamOutbox({ cwd: repo });
        }`);
        const logging = await admin(async team => (await team.query(`SELECT id, actor_id, state, subject FROM rigour.lessons WHERE subject LIKE 'logging:%' ORDER BY created_at`)).rows);
        expect(logging.map((r: any) => [r.actor_id, r.state, r.subject])).toEqual([
            ['dev-b', 'superseded', 'logging: Log the request id.'],
            ['dev-b', 'candidate', 'logging: Log the request id and the tenant.'],
        ]);
        const candidate = logging[1].id;

        const pool = await pg(member.url());
        const insert = (id: string, actor: string, state: string) => pool.query(`INSERT INTO rigour.lessons (id, organization_id, team_id, repository_id, actor_id, visibility, state, kind, subject, evidence_json, confidence, source, created_at, updated_at)
            VALUES ($1, 'example-org', 'web', 'r', $2, 'team', $3, 'memory', 'x: y', '{}', 0.5, 's', 1, 1)`, [id, actor, state]);
        try {
            await expect(pool.query(`UPDATE rigour.lessons SET state = 'promoted' WHERE id = $1`, [candidate])).rejects.toThrow(/row-level security/);
            await expect(pool.query(`UPDATE rigour.lessons SET state = 'rejected' WHERE actor_id = 'dev-a'`)).resolves.toMatchObject({ rowCount: 0 });
            await expect(insert('lesson-b-as-a', 'dev-a', 'candidate')).rejects.toThrow(/row-level security/);
            await expect(insert('lesson-b-promoted', 'dev-b', 'promoted')).rejects.toThrow(/row-level security/);
            await expect(pool.query(`UPDATE rigour.lessons SET subject = 'changed' WHERE state = 'promoted'`)).resolves.toMatchObject({ rowCount: 0 });
            await expect(pool.query(`UPDATE rigour.lessons SET state = 'rejected' WHERE state = 'promoted'`)).resolves.toMatchObject({ rowCount: 0 });
            await expect(pool.query(`DELETE FROM rigour.lessons WHERE visibility = 'team'`)).resolves.toMatchObject({ rowCount: 0 }); // granted for this test
            // A member drops their own candidate: the database stamps who decided.
            await expect(pool.query(`UPDATE rigour.lessons SET state = 'rejected' WHERE id = $1`, [candidate])).resolves.toMatchObject({ rowCount: 1 });
            await expect(pool.query(`UPDATE rigour.lessons SET state = 'candidate' WHERE id = $1`, [candidate])).resolves.toMatchObject({ rowCount: 0 });
        } finally {
            await pool.end();
        }
        expect(await admin(async team => (await team.query('SELECT state, decided_by FROM rigour.lessons WHERE id = $1', [candidate])).rows[0])).toEqual({ state: 'rejected', decided_by: 'dev-b' });
        const states = await admin(async team => (await team.query(`SELECT state, count(*)::int AS n FROM rigour.lessons WHERE kind = 'memory' GROUP BY state ORDER BY state`)).rows);
        expect(states).toEqual([{ state: 'candidate', n: 2 }, { state: 'promoted', n: 2 }, { state: 'rejected', n: 2 }, { state: 'superseded', n: 1 }]);
    }, 120_000);

    it('keeps an sme to what sharing needs: no lesson under a non-member, no rewritten text, no deletes, no evidence of another\'s', async () => {
        const pool = await pg(sme.url());
        const insert = (actor: string) => pool.query(`INSERT INTO rigour.lessons (id, organization_id, team_id, repository_id, actor_id, visibility, state, kind, subject, evidence_json, confidence, source, created_at, updated_at)
            VALUES ('lesson-ghost-' || $1, 'example-org', 'web', 'r', $1, 'team', 'promoted', 'memory', 'ghost: x', '{}', 0.5, 's', 1, 1)`, [actor]);
        try {
            await expect(insert('nobody-here')).rejects.toThrow(/row-level security/);
            const promoted = (await pool.query(`SELECT id FROM rigour.lessons WHERE actor_id = 'dev-a' AND state = 'promoted' LIMIT 1`)).rows[0].id;
            await expect(pool.query(`UPDATE rigour.lessons SET subject = 'rewritten' WHERE id = $1`, [promoted])).rejects.toThrow(/keeps its id, text, author/);
            await expect(pool.query(`UPDATE rigour.lessons SET actor_id = 'reviewer-s' WHERE id = $1`, [promoted])).rejects.toThrow(/keeps its id, text, author/);
            await expect(pool.query(`DELETE FROM rigour.lessons WHERE visibility = 'team'`)).resolves.toMatchObject({ rowCount: 0 }); // granted for this test
            await pool.query(`UPDATE rigour.lessons SET evidence_json = '{"forged": true}', confidence = confidence WHERE id = $1`, [promoted]);
            const row = await admin(async team => (await team.query(`SELECT evidence_json, decided_by FROM rigour.lessons WHERE id = $1`, [promoted])).rows[0]);
            expect(row.evidence_json.forged).toBeUndefined();
            expect(row.decided_by).toBe('reviewer-s');
        } finally {
            await pool.end();
        }
    }, 120_000);

    it("replaces the shared version of a key when a corrected one is shared, and a take back drops one with no newer version", async () => {
        await run(author, `async () => {
            await lessons.shareMemoryLesson(repo, 'retries', 'Use withRetry from lib/net, three attempts.');
            return teamStore.syncTeamOutbox({ cwd: repo });
        }`);
        await run(sme, `async () => {
            await teamStore.syncTeamOutbox({ cwd: repo });
            const corrected = (await memories()).find(l => l.subject === 'retries: Use withRetry from lib/net, three attempts.');
            await lessons.transitionLesson(corrected.id, 'promoted', { visibility: 'team', queueSync: true });
            const timeouts = (await memories()).find(l => l.subject.startsWith('timeouts:') && l.state === 'promoted');
            const taken = await versions.takeBackTeamMemory(timeouts.id);
            await teamStore.syncTeamOutbox({ cwd: repo });
            return taken;
        }`);
        const rows = await admin(async team => (await team.query(
            `SELECT id, actor_id, state, subject, supersedes_id, decided_by AS superseded_by, decided_by AS taken_back_by
             FROM rigour.lessons WHERE (subject LIKE 'retries:%' OR subject LIKE 'timeouts:%') AND source LIKE 'published:%'`)).rows);
        const pick = (subject: string) => rows.find((r: any) => r.subject === subject);
        const [old, current, timeouts] = [pick('retries: Use withRetry from lib/net.'), pick('retries: Use withRetry from lib/net, three attempts.'), pick('timeouts: Every outbound call has a timeout.')];
        expect([old.state, old.subject, old.superseded_by]).toEqual(['superseded', 'retries: Use withRetry from lib/net.', 'reviewer-s']);
        expect([current.actor_id, current.state, current.subject, current.supersedes_id]).toEqual(['dev-a', 'promoted', 'retries: Use withRetry from lib/net, three attempts.', old.id]);
        expect([timeouts.state, timeouts.taken_back_by]).toEqual(['rejected', 'reviewer-s']);
        expect(rows).toHaveLength(3);

        // Agents are given only the version shared now: a member's, who reads only promoted rows, and the sme's.
        const served = 'async () => { await teamStore.syncTeamOutbox({ cwd: repo }); return (await lessons.getApplicableLessons(repo)).lessons.map(l => l.subject).sort(); }';
        expect(await run(member, served)).toEqual(['retries: Use withRetry from lib/net, three attempts.']);
        expect(await run(sme, served)).toEqual(['retries: Use withRetry from lib/net, three attempts.']);
        expect(await run(sme, `async () => (await memories()).filter(l => l.subject.startsWith('timeouts:') && l.state !== 'candidate').map(l => l.state)`)).toEqual(['rejected']);
    }, 120_000);

    it("keeps an sme's own fix out of a teammate's shared fix lesson for the same rule", async () => {
        const evidence = { rule: 'semantic-bugs', files: ['src/a.ts'], examples: [{ fixId: 'f-a', file: 'src/a.ts', resolvedAt: '2026-10-01T00:00:00Z' }] };
        const repositoryId = await run(sme, 'async () => lessons.getRepositoryId(repo)');
        await admin(team => team.query(`INSERT INTO rigour.lessons (id, organization_id, team_id, repository_id, actor_id, visibility, state, kind, subject, evidence_json, confidence, source, created_at, updated_at)
            VALUES ('lesson-fix-a', 'example-org', 'web', $1, 'dev-a', 'team', 'promoted', 'fix', 'Fixed before: Header leaks (semantic-bugs). The header reaches fetch.', $2, 0.8, 'published:x', $3, $3)`, [repositoryId, JSON.stringify(evidence), Date.now()]));
        await run(sme, `async () => {
            await teamStore.syncTeamOutbox({ cwd: repo });
            await fixes.recordFixLessons(repo, [{ id: 'f-s', rule: 'semantic-bugs', title: 'Header leaks', file: 'src/private/s.ts', details: 'Private detail.', resolvedAt: '2026-10-02T00:00:00Z' }]);
            return teamStore.syncTeamOutbox({ cwd: repo });
        }`);
        expect(await admin(async team => (await team.query(`SELECT evidence_json FROM rigour.lessons WHERE id = 'lesson-fix-a'`)).rows[0].evidence_json)).toEqual(evidence);
        expect(await run(sme, `async () => (await lessons.listKnowledgeLessons(repo)).filter(l => l.kind === 'fix').map(l => [l.actorId, l.visibility, l.evidence.files]).sort()`)).toEqual([
            ['dev-a', 'team', ['src/a.ts']],
            ['reviewer-s', 'personal', ['src/private/s.ts']],
        ]);
    }, 120_000);

    it('takes back a lesson stamped by a clock ahead, and takes the team\'s version when a newer one is there', async () => {
        const future = Date.now() + 10 * 24 * 3600_000;
        const repositoryId = await run(sme, 'async () => lessons.getRepositoryId(repo)');
        const promote = (id: string, key: string, at: number) => admin(team => team.query(`INSERT INTO rigour.lessons (id, organization_id, team_id, repository_id, actor_id, visibility, state, kind, subject, evidence_json, confidence, source, created_at, updated_at)
            VALUES ($1, 'example-org', 'web', $2, 'dev-a', 'team', 'promoted', 'memory', $3, $4, 0.9, 'published:' || $1, $5, $5)`, [id, repositoryId, `${key}: from a fast clock`, JSON.stringify({ key, value: 'from a fast clock' }), at]));
        await promote('lesson-skew', 'skew', future);
        await promote('lesson-stale', 'stale', Date.now());
        await sync(sme);
        // Taken back here; before this machine sends it, someone's later change reaches the team database.
        const sent = await run(sme, `async () => {
            await versions.takeBackTeamMemory('lesson-skew');
            await versions.takeBackTeamMemory('lesson-stale');
            return true;
        }`);
        expect(sent).toBe(true);
        await admin(team => team.query(`UPDATE rigour.lessons SET updated_at = $1 WHERE id = 'lesson-stale'`, [future + 1]));
        const states = await run(sme, `async () => {
            await teamStore.syncTeamOutbox({ cwd: repo });
            const local = Object.fromEntries((await memories()).filter(l => l.id === 'lesson-skew' || l.id === 'lesson-stale').map(l => [l.id, l.state]));
            return { local, skew: await outbox.teamSendStateOf('lesson-skew'), stale: await outbox.teamSendStateOf('lesson-stale') };
        }`);
        expect(await admin(async team => (await team.query(`SELECT id, state FROM rigour.lessons WHERE id IN ('lesson-skew', 'lesson-stale') ORDER BY id`)).rows))
            .toEqual([{ id: 'lesson-skew', state: 'rejected' }, { id: 'lesson-stale', state: 'promoted' }]);
        expect(states.skew).toEqual({ state: 'sent' });
        expect(states.stale).toEqual({ state: 'not sent', reason: 'the team database has a newer version of this lesson; this machine now has it' });
        expect(states.local).toEqual({ 'lesson-skew': 'rejected', 'lesson-stale': 'promoted' });
    }, 120_000);

    it("stops serving a shared lesson the team took back, even after a member's own change to it was refused", async () => {
        await sync(member);
        const refused = await run(member, `async () => {
            await lessons.transitionLesson('lesson-stale', 'rejected', { queueSync: true });
            await teamStore.syncTeamOutbox({ cwd: repo });
            return { state: (await memories()).find(l => l.id === 'lesson-stale').state, sent: await outbox.teamSendStateOf('lesson-stale') };
        }`);
        // Refused, and this machine has the team's version back: never a local state the team database does not have.
        expect(refused.state).toBe('promoted');
        expect(refused.sent.reason).toMatch(/^refused by the team database/);
        await run(sme, `async () => { await versions.takeBackTeamMemory('lesson-stale'); return teamStore.syncTeamOutbox({ cwd: repo }); }`);
        expect(await run(member, `async () => {
            await teamStore.syncTeamOutbox({ cwd: repo });
            return (await lessons.getApplicableLessons(repo)).lessons.map(l => l.id).filter(id => id === 'lesson-stale');
        }`)).toEqual([]);
    }, 120_000);

    it('tells an owner when an older init-schema put its policies back beside these', async () => {
        const doctor = 'async () => { const result = await teamStore.doctorTeamConnection(); return [result.candidateReview, result.message]; }';
        expect((await run(sme, doctor))[0]).toBe('ready');
        await admin(team => team.query(LEGACY_POLICIES));
        const [state, message] = await run(sme, doctor);
        expect(state).toBe('older rules');
        expect(message).toContain('never run an older init-schema');
        const { initializeTeamSchema } = await import('./team-store.js');
        await initializeTeamSchema(teamUrl());
        expect((await run(sme, doctor))[0]).toBe('ready');
    }, 120_000);

    it('syncs with the same clients on a database with the policies from before candidate review', async () => {
        await admin(team => team.query(OLD_DATABASE));
        await run(author, `async () => {
            await lessons.shareMemoryLesson(repo, 'naming', 'Hooks are named useX.');
            return teamStore.syncTeamOutbox({ cwd: repo });
        }`);
        const result = await sync(sme);
        expect(result).toMatchObject({ synced: 0 });
        expect(await run(sme, `async () => (await memories()).map(l => l.subject)`)).not.toContain('naming: Hooks are named useX.');
        expect((await reads(sme)).filter(row => row[2] === 'promoted' && !String(row[3]).startsWith('Fixed')).map(row => row[3])).toEqual(['retries: Use withRetry from lib/net, three attempts.']);
        // Sharing its own correction there, the sme cannot retire the author's shared version: refused, and said so.
        const replaced = await run(sme, `async () => {
            await lessons.shareMemoryLesson(repo, 'retries', 'Use withRetry, three attempts, with jitter.');
            const own = (await memories()).find(l => l.subject === 'retries: Use withRetry, three attempts, with jitter.');
            const shared = (await memories()).find(l => l.subject === 'retries: Use withRetry from lib/net, three attempts.' && l.state === 'promoted');
            await lessons.transitionLesson(own.id, 'promoted', { visibility: 'team', queueSync: true });
            await teamStore.syncTeamOutbox({ cwd: repo });
            return outbox.teamSendStateOf(shared.id);
        }`);
        expect(replaced.state).toBe('not sent');
        expect(replaced.reason).toMatch(/^refused by the team database: .*row-level security/);
        expect((await reads(sme)).filter(row => row[2] === 'promoted' && !String(row[3]).startsWith('Fixed')).map(row => row[3]).sort()).toEqual([
            'retries: Use withRetry from lib/net, three attempts.', 'retries: Use withRetry, three attempts, with jitter.',
        ]);
        // A member's team memory is refused there, as before, and kept on record as refused: never silently lost.
        const sent = await run(member, `async () => {
            const id = await lessons.shareMemoryLesson(repo, 'caching', 'Cache reads for a minute.');
            const synced = await teamStore.syncTeamOutbox({ cwd: repo });
            return { synced: synced.synced, state: await outbox.teamSendStateOf(id) };
        }`);
        expect(sent.synced).toBe(0);
        expect(sent.state.state).toBe('not sent');
        expect(sent.state.reason).toMatch(/^refused by the team database: .*row-level security/);
        expect(await admin(async team => (await team.query(`SELECT count(*)::int AS n FROM rigour.lessons WHERE subject LIKE 'caching:%'`)).rows[0].n)).toBe(0);
    }, 120_000);

    it("sends a member's candidates the old database refused once an owner applies this version's schema", async () => {
        const { initializeTeamSchema } = await import('./team-store.js');
        await initializeTeamSchema(teamUrl());
        // The first sync sees the rules arrive and queues the refused candidates again; the next sends them.
        await sync(member);
        await sync(member);
        expect(await admin(async team => (await team.query(`SELECT actor_id, state FROM rigour.lessons WHERE subject LIKE 'caching:%'`)).rows)).toEqual([{ actor_id: 'dev-b', state: 'candidate' }]);
    }, 120_000);
});
