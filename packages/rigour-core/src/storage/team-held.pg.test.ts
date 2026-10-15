/**
 * Against a real PostgreSQL, when RIGOUR_TEST_DATABASE_URL names a database an administrator owns (skipped otherwise):
 * team memories saved in a repository the team does not list yet are held, then sent once the repository is listed.
 * The test works in a database of its own, created and dropped here, so it never meets another test's schema.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.RIGOUR_TEST_DATABASE_URL;
const DATABASE = `rigour_held_${process.pid}`;

describe.skipIf(!URL)('team memories from a repository the team does not list yet, on a real PostgreSQL', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'team-held-home-'));
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'team-held-repo-'));
    const saved = { ...process.env };
    const teamUrl = () => { const url = new globalThis.URL(URL!); url.pathname = `/${DATABASE}`; return url.toString(); };
    const pg = async (connectionString: string) => new (await import('pg')).Pool({ connectionString });
    const lessonsInTeam = async () => {
        const pool = await pg(teamUrl());
        try { return Number((await pool.query('SELECT COUNT(*) AS count FROM rigour.lessons')).rows[0].count); } finally { await pool.end(); }
    };

    beforeAll(async () => {
        const admin = await pg(URL!);
        await admin.query(`DROP DATABASE IF EXISTS ${DATABASE}`);
        await admin.query(`CREATE DATABASE ${DATABASE}`);
        await admin.end();
        fs.mkdirSync(path.join(repo, '.git'));
        fs.writeFileSync(path.join(repo, '.git', 'config'), '[remote "origin"]\n\turl = https://forge.example.com/example-org/widgets.git\n');
        Object.assign(process.env, {
            RIGOUR_HOME: home, RIGOUR_TEAM_DATABASE_URL: teamUrl(), RIGOUR_ORGANIZATION_ID: 'example-org',
            RIGOUR_TEAM_ID: 'platform', RIGOUR_ACTOR_ID: 'dev-a', RIGOUR_TEAM_REPOSITORIES: 'forge.example.com/example-org/api',
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

    it('holds them, says so, and sends them with the first sync after the repository is added', async () => {
        // Imported here: the local store's path comes from RIGOUR_HOME when the module loads.
        const { shareMemoryLesson } = await import('./lessons.js');
        const { doctorTeamConnection, syncTeamOutbox } = await import('./team-store.js');
        for (const key of ['naming', 'retries', 'logging']) await shareMemoryLesson(repo, key, `Synthetic ${key} convention.`);

        const held = await syncTeamOutbox({ cwd: repo });
        expect(held).toMatchObject({ pending: 0, held: 3, withheld: 0, synced: 0 });
        expect(held.heldBecause).toEqual(["repository forge.example.com/example-org/widgets is not one of the team's repositories"]);
        expect(await lessonsInTeam()).toBe(0);
        expect((await doctorTeamConnection(undefined, repo)).repository).toEqual({
            listed: false,
            warning: "This repository is not in the team's repositories: team memories and lessons saved here are kept as team candidates on this machine and sent once it is: set RIGOUR_TEAM_REPOSITORIES='forge.example.com/example-org/api,forge.example.com/example-org/widgets'",
        });
        expect(await syncTeamOutbox({ cwd: repo })).toMatchObject({ held: 3, synced: 0 }); // still queued, never set aside

        process.env.RIGOUR_TEAM_REPOSITORIES = 'forge.example.com/example-org/api,forge.example.com/example-org/widgets';
        expect(await syncTeamOutbox({ cwd: repo })).toMatchObject({ pending: 3, held: 0, synced: 3 });
        expect(await lessonsInTeam()).toBe(3);
        expect((await doctorTeamConnection(undefined, repo)).repository).toEqual({ listed: true });
        expect(await syncTeamOutbox({ dryRun: true, cwd: repo })).toMatchObject({ pending: 0, held: 0 });
    });
});
