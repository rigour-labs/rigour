/**
 * Against a real PostgreSQL, when RIGOUR_TEST_DATABASE_URL names a database an administrator owns (skipped otherwise):
 * a teammate's fresh clone (or a cloud reviewer's), with team mode from the environment alone, gets the team's
 * promoted memories from its very first rigour_recall, and a recall with no arguments lists them. The memories were
 * published from a checkout whose remote gave the repository another id. The test works in a database of its own.
 */
import fs from 'fs';
import { createRequire } from 'module';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.RIGOUR_TEST_DATABASE_URL;
const DATABASE = `rigour_fresh_clone_${process.pid}`;

describe.skipIf(!URL)('promoted team memories on a fresh clone, on a real PostgreSQL', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fresh-clone-home-'));
    const clone = fs.mkdtempSync(path.join(os.tmpdir(), 'fresh-clone-repo-'));
    const saved = { ...process.env };
    const teamUrl = () => { const url = new globalThis.URL(URL!); url.pathname = `/${DATABASE}`; return url.toString(); };
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
        await admin.end();
        // The fresh clone: an https origin, no .rigour, no team.json; team mode from the environment only.
        fs.mkdirSync(path.join(clone, '.git'));
        fs.writeFileSync(path.join(clone, '.git', 'config'), '[remote "origin"]\n\turl = https://forge.example.com/example-org/widgets.git\n');
        Object.assign(process.env, {
            RIGOUR_HOME: home, RIGOUR_TEAM_DATABASE_URL: teamUrl(), RIGOUR_ORGANIZATION_ID: 'example-org',
            RIGOUR_TEAM_ID: 'web', RIGOUR_ACTOR_ID: 'sam', RIGOUR_TELEMETRY: '0',
        });
        delete process.env.RIGOUR_TEAM_REPOSITORIES;
        const { initializeTeamSchema } = await import('@rigour-labs/core');
        await initializeTeamSchema(teamUrl());
        const team = await pg(teamUrl());
        const now = Date.now();
        await team.query(`INSERT INTO rigour.memberships (db_role, organization_id, team_id, actor_id, role) VALUES (current_user, 'example-org', 'web', 'sam', 'sme')`);
        for (const [n, key, value] of [
            [1, 'db-migrations', 'Run migrations before deploying the worker; the worker reads new columns.'],
            [2, 'retry-window', 'Bound the retry window at both ends.'],
            [3, 'migration-order', 'Additive migrations ship before the code that uses them.'],
        ] as const) {
            // Published from another checkout of the repository, whose remote form gave it another repository id.
            await team.query(
                `INSERT INTO rigour.lessons (id, organization_id, team_id, repository_id, actor_id, visibility, state, kind, subject,
                    evidence_json, confidence, source, created_at, updated_at)
                 VALUES ($1, 'example-org', 'web', 'repo-from-another-remote', 'sam', 'team', 'promoted', 'memory', $2, $3::jsonb, 0.9, $4, $5, $5)`,
                [`lesson-published-${n}`, `${key}: ${value}`, JSON.stringify({ key, value }), `published:lesson-local-${n}`, now],
            );
        }
        await team.end();
    });

    afterAll(async () => {
        process.env = { ...saved };
        const admin = await pg(URL!);
        await admin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
        await admin.end();
        for (const dir of [home, clone]) fs.rmSync(dir, { recursive: true, force: true });
    });

    it('answers the first recall with them, and lists them with no arguments', async () => {
        // Imported here: the local store's path comes from RIGOUR_HOME when the modules load.
        const { firstTeamSync } = await import('../utils/team-pull.js');
        const { handleRecall } = await import('./memory-recall.js');
        void firstTeamSync(clone); // as the server does when the first tool call arrives

        const found = text(await handleRecall(clone, { query: 'migrations' }));
        expect(found).toContain('db-migrations: Run migrations before deploying the worker');
        expect(found).toContain('migration-order: Additive migrations ship before the code that uses them.');
        expect(found).not.toContain('NO MEMORY MATCHES');
        expect(found).not.toContain('still being fetched');

        const listed = text(await handleRecall(clone));
        expect(listed).not.toContain('NO MEMORIES STORED');
        for (const key of ['db-migrations', 'retry-window', 'migration-order']) expect(listed).toContain(`- ${key}: `);
    }, 60_000);
});
