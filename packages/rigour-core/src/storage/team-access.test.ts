import { describe, expect, it } from 'vitest';
import { accessChange, decidesTeammatesCandidates, readMembershipAccess, recordTeamAccess, schemaNote, sentActorOf } from './team-access.js';
import { isTrustedLesson } from './lessons.js';

const scope = { organizationId: 'acme', teamId: 'web', actorId: 'reviewer-a' };
const meta = () => {
    const values = new Map<string, string>();
    return {
        get: async (_sql: string, key: unknown) => (values.has(String(key)) ? { value: values.get(String(key)) } : undefined),
        run: async (_sql: string, key: unknown, value: unknown) => { values.set(String(key), String(value)); },
    };
};

describe('team access', () => {
    it('lets an sme or owner decide on teammates\' candidates only where the database has candidate review', () => {
        expect(decidesTeammatesCandidates(undefined)).toBeUndefined();
        expect(decidesTeammatesCandidates({ candidateReview: true })).toBeUndefined();
        expect(decidesTeammatesCandidates({ role: 'sme', candidateReview: true })).toBe(true);
        expect(decidesTeammatesCandidates({ role: 'owner', candidateReview: false })).toBe(false);
        expect(decidesTeammatesCandidates({ role: 'member', candidateReview: true })).toBe(false);
    });

    it("writes a teammate's team row under its author for an sme on a new schema, and everything else under the login's own actor", () => {
        const sme = { role: 'sme' as const, candidateReview: true };
        expect(sentActorOf({ visibility: 'team', actorId: 'dev-b' }, sme, 'reviewer-a')).toBe('dev-b');
        expect(sentActorOf({ visibility: 'team', actorId: 'reviewer-a' }, sme, 'reviewer-a')).toBeNull();
        expect(sentActorOf({ visibility: 'personal', actorId: 'dev-b' }, sme, 'reviewer-a')).toBeNull();
        expect(sentActorOf({ visibility: 'team', actorId: 'dev-b' }, { role: 'sme', candidateReview: false }, 'reviewer-a')).toBeNull();
        expect(sentActorOf({ visibility: 'team', actorId: 'dev-b' }, { role: 'member', candidateReview: true }, 'reviewer-a')).toBeNull();
    });

    it('reads the role from the membership row, and the candidate rules from rigour.meta and pg_policies', async () => {
        const pool = (role: string | undefined, rules: { version: string | null; rules: number; legacy: number }) => ({
            query: async (sql: string) => (sql.includes('pg_policies') ? { rowCount: 1, rows: [rules] } : { rowCount: role ? 1 : 0, rows: role ? [{ role }] : [] }),
        });
        expect(await readMembershipAccess(pool('member', { version: '2', rules: 4, legacy: 0 }), scope)).toEqual({ role: 'member', candidateReview: true });
        expect(await readMembershipAccess(pool('owner', { version: null, rules: 0, legacy: 1 }), scope)).toEqual({ role: 'owner', candidateReview: false });
        // An older init-schema ran after this version's: its policies sit beside these, and the meta key alone would lie.
        const older = await readMembershipAccess(pool('sme', { version: '2', rules: 4, legacy: 2 }), scope);
        expect(older).toEqual({ role: 'sme', candidateReview: false, olderRules: true });
        expect(schemaNote(older!)).toContain('never run an older init-schema');
        expect(schemaNote({ candidateReview: false })).toContain('rigour team init-schema --database-url <administrator url>');
        expect(await readMembershipAccess(pool(undefined, { version: '2', rules: 4, legacy: 0 }), scope)).toBeUndefined();
    });

    it('says once how access changed: widened for a new sme, rules arrived, narrowed for a demoted sme', async () => {
        const db = meta();
        const sme = { role: 'sme' as const, candidateReview: true };
        await recordTeamAccess(db, scope, { role: 'sme', candidateReview: false });
        expect(await accessChange(db, scope, sme)).toEqual({ widened: true, rulesArrived: true, narrowed: false });
        await recordTeamAccess(db, scope, sme);
        expect(await accessChange(db, scope, sme)).toEqual({ widened: false, rulesArrived: false, narrowed: false });
        expect(await accessChange(db, scope, { role: 'member', candidateReview: true })).toEqual({ widened: false, rulesArrived: false, narrowed: true });
    });
});

describe('trusted lessons', () => {
    it("serves another person's team lesson only once promoted", () => {
        expect(isTrustedLesson({ state: 'promoted', visibility: 'team', actorId: 'dev-b' }, 'reviewer-a')).toBe(true);
        expect(isTrustedLesson({ state: 'validated', visibility: 'team', actorId: 'dev-b' }, 'reviewer-a')).toBe(false);
        expect(isTrustedLesson({ state: 'validated', visibility: 'team', actorId: 'reviewer-a' }, 'reviewer-a')).toBe(true);
        expect(isTrustedLesson({ state: 'validated', visibility: 'personal', actorId: 'reviewer-a' }, 'reviewer-a')).toBe(true);
        expect(isTrustedLesson({ state: 'candidate', visibility: 'team', actorId: 'dev-b' }, 'reviewer-a')).toBe(false);
    });
});
