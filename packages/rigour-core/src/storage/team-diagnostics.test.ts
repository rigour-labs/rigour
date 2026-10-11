import { describe, expect, it } from 'vitest';
import { diagnoseMissingMembership, explainSyncError, explainTeamConnectionError, missingReviewDecisionGrants, refusedRow, type QueryablePool } from './team-diagnostics.js';
import { TEAM_SCHEMA } from './team-schema.js';

function pool(rows: Array<Record<string, unknown>> | Error): QueryablePool {
    return {
        query: async () => {
            if (rows instanceof Error) throw rows;
            return { rows, rowCount: rows.length };
        },
    };
}

describe('explainTeamConnectionError', () => {
    it('explains an untrusted certificate chain with the CA fix', () => {
        const message = explainTeamConnectionError(Object.assign(new Error('self-signed certificate in certificate chain'), { code: 'SELF_SIGNED_CERT_IN_CHAIN' }));
        expect(message).toContain('NODE_EXTRA_CA_CERTS');
        expect(message).toContain('sslmode=verify-full');
    });

    it('points a missing schema at init-schema', () => {
        expect(explainTeamConnectionError({ code: '42P01', message: 'relation "rigour.memberships" does not exist' })).toContain('rigour team init-schema');
    });

    it('explains a rejected login and an unreachable host', () => {
        expect(explainTeamConnectionError({ code: '28P01', message: 'password authentication failed' })).toContain('rejected the login');
        expect(explainTeamConnectionError({ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' })).toContain('Cannot reach');
    });

    it('passes other errors through', () => {
        expect(explainTeamConnectionError(new Error('something else'))).toBe('something else');
    });
});

describe('diagnoseMissingMembership', () => {
    it('names row-level security without a policy as the cause', async () => {
        const message = await diagnoseMissingMembership(pool([{ table_name: 'memberships' }, { table_name: 'meta' }]));
        expect(message).toContain('rigour.memberships and rigour.meta');
        expect(message).toContain('init-schema');
    });

    it('reports a missing membership when nothing hides it', async () => {
        expect(await diagnoseMissingMembership(pool([]))).toContain('no membership');
    });

    it('falls back to the membership message when the catalog cannot be read', async () => {
        expect(await diagnoseMissingMembership(pool(new Error('permission denied')))).toContain('no membership');
    });
});

describe('team schema', () => {
    it('protects every team table with row-level security and a read policy', () => {
        for (const table of ['lessons', 'memberships', 'meta']) {
            expect(TEAM_SCHEMA).toContain(`ALTER TABLE rigour.${table} ENABLE ROW LEVEL SECURITY;`);
        }
        expect(TEAM_SCHEMA).toContain('CREATE POLICY memberships_read_own ON rigour.memberships FOR SELECT USING (db_role = current_user);');
        expect(TEAM_SCHEMA).toContain('CREATE POLICY meta_read ON rigour.meta FOR SELECT USING (true);');
    });

    it('adds review decisions without changing the version older clients check', () => {
        expect(TEAM_SCHEMA).toContain("VALUES ('schema_version', '1')");
        expect(TEAM_SCHEMA).toContain("VALUES ('review_decisions_version', '1')");
        for (const table of ['review_decisions', 'organization_salts']) {
            expect(TEAM_SCHEMA).toContain(`ALTER TABLE rigour.${table} ENABLE ROW LEVEL SECURITY;`);
        }
    });

    it('lets review decisions be read and inserted only, the insert only by an sme or owner under their own actor', () => {
        const policies = [...TEAM_SCHEMA.matchAll(/CREATE POLICY (\w+) ON rigour\.review_decisions FOR (\w+)/g)].map(m => `${m[1]} ${m[2]}`);
        expect(policies).toEqual(['review_decisions_read SELECT', 'review_decisions_insert INSERT']);
        const insert = TEAM_SCHEMA.slice(TEAM_SCHEMA.indexOf('CREATE POLICY review_decisions_insert'));
        expect(insert.slice(0, insert.indexOf(');'))).toContain("membership.role IN ('sme', 'owner')");
        expect(insert.slice(0, insert.indexOf(');'))).toContain('membership.actor_id = review_decisions.actor_id');
    });

    it('stamps when a decision arrived and who made it on the server', () => {
        const stamp = TEAM_SCHEMA.slice(TEAM_SCHEMA.indexOf('FUNCTION rigour.stamp_review_decision'), TEAM_SCHEMA.indexOf('END $$;', TEAM_SCHEMA.indexOf('FUNCTION rigour.stamp_review_decision')));
        expect(stamp).toContain('NEW.received_at := clock_timestamp();');
        expect(stamp).toContain('SELECT membership.display_name FROM rigour.memberships');
        expect(TEAM_SCHEMA).toContain('BEFORE INSERT ON rigour.review_decisions');
    });

    it('widens the decision kinds in place, and says so, so a client sends not-a-rule and took-back only then', () => {
        expect(TEAM_SCHEMA).toContain('ALTER TABLE rigour.review_decisions DROP CONSTRAINT IF EXISTS review_decisions_kind_check;');
        expect(TEAM_SCHEMA).toContain("'not-a-rule', 'took-back'))");
        expect(TEAM_SCHEMA).toContain("VALUES ('review_decision_kinds_version', '2')");
    });
});

describe('missingReviewDecisionGrants', () => {
    const grants = (salts: boolean, select: boolean, insert: boolean) => pool([{ salts_select: salts, decisions_select: select, decisions_insert: insert }]);

    it('names each missing grant as the GRANT the administrator runs', async () => {
        expect(await missingReviewDecisionGrants(grants(false, false, false), 'rigour_jane', 'sme')).toBe(
            'missing grant for review decisions: ask the administrator to run: GRANT SELECT ON rigour.organization_salts TO "rigour_jane"; GRANT SELECT, INSERT ON rigour.review_decisions TO "rigour_jane";');
        expect(await missingReviewDecisionGrants(grants(false, true, true), 'rigour_jane', 'owner')).toBe(
            'missing grant for review decisions: ask the administrator to run: GRANT SELECT ON rigour.organization_salts TO "rigour_jane";');
    });

    it('asks a member only to read: a member never sends', async () => {
        expect(await missingReviewDecisionGrants(grants(true, true, false), 'rigour_sam', 'member')).toBeUndefined();
        expect(await missingReviewDecisionGrants(grants(true, false, false), 'rigour_sam', 'member')).toContain('GRANT SELECT ON rigour.review_decisions TO "rigour_sam";');
        expect(await missingReviewDecisionGrants(grants(true, true, false), 'rigour_jane', 'sme')).toContain('GRANT SELECT, INSERT ON rigour.review_decisions');
    });

    it('is quiet when every grant is there, and quotes an odd login name', async () => {
        expect(await missingReviewDecisionGrants(grants(true, true, true), 'rigour_jane', 'sme')).toBeUndefined();
        expect(await missingReviewDecisionGrants(grants(false, true, true), 'we"ird', 'sme')).toContain('TO "we""ird";');
    });
});

describe('a sync failure, in one line', () => {
    const URL = 'postgresql://rigour_jane:secret@db.example.com:5432/rigour?sslmode=verify-full';
    const denied = (table: string) => Object.assign(new Error(`permission denied for table ${table}`), { code: '42501', severity: 'ERROR', routine: 'aclcheck_error', stack: 'error: …\n    at Parser.parseErrorMessage (…)' });

    it('names the missing grant and the GRANT to run, never the password or a stack', () => {
        const line = explainSyncError(denied('organization_salts'), URL);
        expect(line).toBe('your login lacks SELECT on rigour.organization_salts; ask the administrator to run: GRANT SELECT ON rigour.organization_salts TO "rigour_jane";');
        expect(explainSyncError(denied('review_decisions'), URL)).toContain('GRANT SELECT, INSERT ON rigour.review_decisions TO "rigour_jane";');
        expect(explainSyncError(Object.assign(new Error('permission denied for schema rigour'), { code: '42501' }), URL)).toContain('GRANT USAGE ON SCHEMA rigour TO "rigour_jane";');
        for (const out of [line, explainSyncError(new Error('boom'), URL)]) {
            expect(out).not.toContain('secret');
            expect(out).not.toContain('\n');
        }
    });

    it('passes connection problems through as their own explanation', () => {
        expect(explainSyncError({ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' }, URL)).toContain('Cannot reach the team database');
    });

    it('sets aside only a row Postgres refused for itself: row-level security or a constraint, never a missing grant', () => {
        expect(refusedRow(Object.assign(new Error('new row violates row-level security policy for table "review_decisions"'), { code: '42501' }))).toBe(true);
        expect(refusedRow({ code: '23514', message: 'violates check constraint' })).toBe(true);
        expect(refusedRow(denied('review_decisions'))).toBe(false);
        expect(refusedRow({ code: 'ECONNRESET' })).toBe(false);
    });
});
