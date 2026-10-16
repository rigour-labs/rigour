/**
 * Against a real PostgreSQL, when RIGOUR_TEST_DATABASE_URL names a database an administrator owns (skipped otherwise):
 * what rigour_remember with scope team tells a member's agent. On a database whose schema lets members propose, the
 * candidate is sent; on one with the write rules from before, the database refuses it and the reply says NOT SENT,
 * with the refusal. The member syncs through a login of their own, so the row-level security policies apply.
 */
import fs from 'fs';
import { createRequire } from 'module';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.RIGOUR_TEST_DATABASE_URL;
const DATABASE = `rigour_remember_member_${process.pid}`;
const MEMBER = `rigour_remember_member_${process.pid}`;

/** The lessons write rule from before member candidates: a member writes personal lessons only. */
const OLD_WRITE_POLICY = `
DROP POLICY IF EXISTS lessons_write ON rigour.lessons;
CREATE POLICY lessons_write ON rigour.lessons FOR ALL USING (EXISTS (
    SELECT 1 FROM rigour.memberships membership
    WHERE membership.db_role = current_user AND membership.organization_id = lessons.organization_id AND membership.team_id = lessons.team_id
      AND membership.actor_id = lessons.actor_id AND (lessons.visibility = 'personal' OR membership.role IN ('sme', 'owner'))));
`;

describe.skipIf(!URL)("a member's rigour_remember with scope team, on a real PostgreSQL", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'remember-member-home-'));
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'remember-member-repo-'));
    const saved = { ...process.env };
    const teamUrl = () => { const url = new globalThis.URL(URL!); url.pathname = `/${DATABASE}`; return url.toString(); };
    const memberUrl = () => { const url = new globalThis.URL(teamUrl()); url.username = MEMBER; url.password = 'synthetic-member-pass'; return url.toString(); };
    // The PostgreSQL driver is core's (optional) dependency, not this package's: load it from there.
    const pg = async (connectionString: string) => {
        const core = new globalThis.URL('../../node_modules/@rigour-labs/core/package.json', import.meta.url);
        const { Pool } = createRequire(core)('pg') as typeof import('pg');
        return new Pool({ connectionString });
    };
    const text = (result: { content: Array<{ text: string }> }) => result.content.map(c => c.text).join('\n');

    beforeAll(async () => {
        const admin = await pg(URL!);
        await admin.query(`DROP DATABASE IF EXISTS ${DATABASE}`);
        await admin.query(`CREATE DATABASE ${DATABASE}`);
        await admin.query(`DROP ROLE IF EXISTS ${MEMBER}`);
        await admin.query(`CREATE ROLE ${MEMBER} LOGIN PASSWORD 'synthetic-member-pass'`);
        await admin.end();
        fs.mkdirSync(path.join(repo, '.git'));
        fs.writeFileSync(path.join(repo, '.git', 'config'), '[remote "origin"]\n\turl = https://forge.example.com/example-org/widgets.git\n');
        Object.assign(process.env, {
            RIGOUR_HOME: home, RIGOUR_TEAM_DATABASE_URL: teamUrl(), RIGOUR_ORGANIZATION_ID: 'example-org', RIGOUR_TEAM_ID: 'web',
            RIGOUR_ACTOR_ID: 'dev-b', RIGOUR_TELEMETRY: '0', RIGOUR_TEAM_REPOSITORIES: 'forge.example.com/example-org/widgets',
        });
        const { initializeTeamSchema } = await import('@rigour-labs/core');
        await initializeTeamSchema(teamUrl());
        const team = await pg(teamUrl());
        await team.query(`INSERT INTO rigour.memberships (db_role, organization_id, team_id, actor_id, role) VALUES ('${MEMBER}', 'example-org', 'web', 'dev-b', 'member')`);
        await team.end();
        await initializeTeamSchema(teamUrl()); // grants the member login its tables
        process.env.RIGOUR_TEAM_DATABASE_URL = memberUrl();
    });

    afterAll(async () => {
        process.env = { ...saved };
        const admin = await pg(URL!);
        await admin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
        await admin.query(`DROP ROLE IF EXISTS ${MEMBER}`);
        await admin.end();
        for (const dir of [home, repo]) fs.rmSync(dir, { recursive: true, force: true });
    });

    it('says sent where members may propose, and NOT SENT with the refusal where they may not', async () => {
        const { handleRemember } = await import('./memory-handlers.js');
        expect(text(await handleRemember(repo, 'timeouts', 'Every outbound call has a timeout.', 'team'))).toContain('Sent to the team database as a candidate.');

        const team = await pg(teamUrl());
        await team.query(OLD_WRITE_POLICY);
        await team.end();
        const refused = text(await handleRemember(repo, 'caching', 'Cache reads for a minute.', 'team'));
        expect(refused).toMatch(/NOT SENT: the team database did not take this candidate \(refused by the team database: .*row-level security/);
    }, 60_000);
});
