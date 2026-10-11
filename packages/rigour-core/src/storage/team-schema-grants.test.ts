import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/** A PostgreSQL that records every statement; the member logins and the tables present are set per test. */
const db = vi.hoisted(() => ({ roles: [] as string[], tables: [] as string[], denied: false, statements: [] as string[] }));
vi.mock('pg', () => ({
    Pool: class {
        async query(sql: string, params?: unknown[]) {
            db.statements.push(sql);
            if (sql.includes('FROM rigour.memberships')) return { rows: db.roles.map(role => ({ role })) };
            if (sql.includes('to_regclass')) return { rows: (params?.[0] as string[]).filter(name => db.tables.includes(name)).map(name => ({ name })) };
            if (sql.startsWith('GRANT') && db.denied) throw Object.assign(new Error('permission denied'), { code: '42501' });
            return { rows: [] };
        }
        async end() { }
    },
}));

import { initializeTeamSchema } from './team-store.js';

const URL = 'postgresql://admin@127.0.0.1/rigour';

describe('rigour team init-schema grants the member logins', () => {
    it('grants every member login what a sync needs on every team table there is, and says so', async () => {
        Object.assign(db, { roles: ['rigour_jane', 'rigour "q"'], tables: ['meta', 'memberships', 'lessons', 'organization_salts', 'review_decisions'], denied: false, statements: [] });
        const grants = await initializeTeamSchema(URL);
        expect(grants.manual).toEqual([]);
        expect(grants.granted.map(g => g.role)).toEqual(['rigour_jane', 'rigour "q"']);
        expect(grants.granted[0].statements).toEqual([
            'GRANT USAGE ON SCHEMA rigour TO "rigour_jane";',
            'GRANT SELECT ON rigour.meta TO "rigour_jane";',
            'GRANT SELECT ON rigour.memberships TO "rigour_jane";',
            'GRANT SELECT, INSERT, UPDATE ON rigour.lessons TO "rigour_jane";',
            'GRANT SELECT ON rigour.organization_salts TO "rigour_jane";',
            'GRANT SELECT, INSERT ON rigour.review_decisions TO "rigour_jane";',
        ]); // no lesson_embeddings: that table is not there without pgvector
        expect(grants.granted[1].statements[0]).toBe('GRANT USAGE ON SCHEMA rigour TO "rigour ""q""";'); // a role name is quoted
    });

    it('returns the GRANTs it may not run, for the administrator', async () => {
        Object.assign(db, { roles: ['rigour_jane'], tables: ['review_decisions'], denied: true, statements: [] });
        const grants = await initializeTeamSchema(URL);
        expect(grants.granted).toEqual([]);
        expect(grants.manual).toEqual(['GRANT USAGE ON SCHEMA rigour TO "rigour_jane";', 'GRANT SELECT, INSERT ON rigour.review_decisions TO "rigour_jane";']);
    });

    it('has nothing to grant before any member login exists', async () => {
        Object.assign(db, { roles: [], tables: ['meta'], denied: false, statements: [] });
        expect(await initializeTeamSchema(URL)).toEqual({ granted: [], manual: [] });
    });
});
