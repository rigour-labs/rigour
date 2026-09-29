import { describe, expect, it } from 'vitest';
import { diagnoseMissingMembership, explainTeamConnectionError, type QueryablePool } from './team-diagnostics.js';
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
});
