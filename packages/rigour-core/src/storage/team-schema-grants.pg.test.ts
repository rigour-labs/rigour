/**
 * Against a real PostgreSQL, when RIGOUR_TEST_DATABASE_URL names a throwaway database an administrator owns (skipped
 * otherwise): an upgrade from the shape before 7.0.0, with one member login granted as the guide said then.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { initializeTeamSchema } from './team-store.js';

const URL = process.env.RIGOUR_TEST_DATABASE_URL;
const MEMBER = 'rigour_upgrade_member';

describe.skipIf(!URL)('rigour team init-schema on a real PostgreSQL', () => {
    const pg = async () => new (await import('pg')).Pool({ connectionString: URL });

    afterAll(async () => {
        const pool = await pg();
        await pool.query('DROP SCHEMA IF EXISTS rigour CASCADE');
        await pool.query(`DROP ROLE IF EXISTS ${MEMBER}`);
        await pool.end();
    });

    it('lets an existing member login use the tables 7.0.0 adds, with no GRANT left to run', async () => {
        const pool = await pg();
        await pool.query('DROP SCHEMA IF EXISTS rigour CASCADE');
        await pool.query(`DROP ROLE IF EXISTS ${MEMBER}`);
        await initializeTeamSchema(URL!);
        // The shape before 7.0.0: no review decisions or organization salts yet, one member granted as the guide said then.
        await pool.query('DROP TRIGGER memberships_organization_salt ON rigour.memberships');
        await pool.query('DROP TABLE rigour.review_decisions, rigour.organization_salts CASCADE');
        await pool.query(`CREATE ROLE ${MEMBER} LOGIN`);
        await pool.query(`INSERT INTO rigour.memberships (db_role, organization_id, team_id, actor_id, role) VALUES ('${MEMBER}', 'org', 'team', 'actor', 'member')`);
        await pool.query(`GRANT USAGE ON SCHEMA rigour TO ${MEMBER}; GRANT SELECT ON rigour.meta, rigour.memberships TO ${MEMBER}; GRANT SELECT, INSERT, UPDATE ON rigour.lessons TO ${MEMBER};`);

        const grants = await initializeTeamSchema(URL!); // the upgrade
        expect(grants.manual).toEqual([]);
        expect(grants.granted.map(g => g.role)).toEqual([MEMBER]);
        const { rows } = await pool.query(`SELECT has_table_privilege('${MEMBER}', 'rigour.review_decisions', 'SELECT') AS decisions_select,
            has_table_privilege('${MEMBER}', 'rigour.review_decisions', 'INSERT') AS decisions_insert,
            has_table_privilege('${MEMBER}', 'rigour.organization_salts', 'SELECT') AS salts_select`);
        expect(rows[0]).toEqual({ decisions_select: true, decisions_insert: true, salts_select: true });
        await pool.end();
    });
});
