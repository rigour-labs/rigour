/**
 * Against a real PostgreSQL, when RIGOUR_TEST_DATABASE_URL names a database an administrator owns (skipped otherwise):
 * a corrected team memory reaches the team database as one candidate, with the version it replaced marked superseded,
 * so a person deciding in Studio never sees both. The test works in a database of its own, created and dropped here.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.RIGOUR_TEST_DATABASE_URL;
const DATABASE = `rigour_supersede_${process.pid}`;

describe.skipIf(!URL)('a corrected team memory on a real PostgreSQL', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'team-supersede-home-'));
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'team-supersede-repo-'));
    const saved = { ...process.env };
    const teamUrl = () => { const url = new globalThis.URL(URL!); url.pathname = `/${DATABASE}`; return url.toString(); };
    const pg = async (connectionString: string) => new (await import('pg')).Pool({ connectionString });

    beforeAll(async () => {
        const admin = await pg(URL!);
        await admin.query(`DROP DATABASE IF EXISTS ${DATABASE}`);
        await admin.query(`CREATE DATABASE ${DATABASE}`);
        await admin.end();
        fs.mkdirSync(path.join(repo, '.git'));
        fs.writeFileSync(path.join(repo, '.git', 'config'), '[remote "origin"]\n\turl = https://forge.example.com/example-org/widgets.git\n');
        Object.assign(process.env, {
            RIGOUR_HOME: home, RIGOUR_TEAM_DATABASE_URL: teamUrl(), RIGOUR_ORGANIZATION_ID: 'example-org',
            RIGOUR_TEAM_ID: 'platform', RIGOUR_ACTOR_ID: 'dev-a', RIGOUR_TEAM_REPOSITORIES: 'forge.example.com/example-org/widgets',
        });
        const { initializeTeamSchema } = await import('./team-store.js');
        await initializeTeamSchema(teamUrl());
        const team = await pg(teamUrl());
        await team.query(`INSERT INTO rigour.memberships (db_role, organization_id, team_id, actor_id, role) VALUES (current_user, 'example-org', 'platform', 'dev-a', 'sme')`);
        await team.end();
    });

    afterAll(async () => {
        process.env = { ...saved };
        const admin = await pg(URL!);
        await admin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
        await admin.end();
        for (const dir of [home, repo]) fs.rmSync(dir, { recursive: true, force: true });
    });

    it('leaves one candidate for the key, and the replaced one superseded', async () => {
        const { shareMemoryLesson } = await import('./lessons.js');
        const { syncTeamOutbox } = await import('./team-store.js');
        const first = await shareMemoryLesson(repo, 'retries', 'Use withRetry.');
        expect(await syncTeamOutbox({ cwd: repo })).toMatchObject({ synced: 1 });
        const corrected = await shareMemoryLesson(repo, 'retries', 'Use withRetry from lib/net, three attempts.');
        await syncTeamOutbox({ cwd: repo });

        const team = await pg(teamUrl());
        try {
            const rows = (await team.query('SELECT id, state, subject, supersedes_id FROM rigour.lessons ORDER BY created_at')).rows;
            expect(rows).toEqual([
                { id: first, state: 'superseded', subject: 'retries: Use withRetry.', supersedes_id: null },
                { id: corrected, state: 'candidate', subject: 'retries: Use withRetry from lib/net, three attempts.', supersedes_id: first },
            ]);
        } finally {
            await team.end();
        }
    });
});
