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

    it('reads the role from the membership row, and the candidate rules from rigour.candidate_review_state()', async () => {
        const pool = (role: string | undefined, state: string | Error, version: string | null = null) => ({
            query: async (sql: string) => {
                if (sql.includes('candidate_review_state')) {
                    if (state instanceof Error) throw state;
                    return { rowCount: 1, rows: [{ state }] };
                }
                if (sql.includes('rigour.meta')) return { rowCount: 1, rows: [{ value: version }] };
                return { rowCount: role ? 1 : 0, rows: role ? [{ role }] : [] };
            },
        });
        expect(await readMembershipAccess(pool('member', 'ready'), scope)).toEqual({ role: 'member', candidateReview: true });
        expect(await readMembershipAccess(pool('owner', 'missing'), scope)).toEqual({ role: 'owner', candidateReview: false });
        // An older init-schema ran after this version's: its policies sit beside these, and the meta key alone would lie.
        const older = await readMembershipAccess(pool('sme', 'older rules'), scope);
        expect(older).toEqual({ role: 'sme', candidateReview: false, olderRules: true });
        expect(schemaNote(older!)).toContain('never run an older init-schema');
        expect(schemaNote({ candidateReview: false })).toContain('rigour team init-schema --database-url <administrator url>');
        // A login that may not run the function (or a database without it): the version key alone, and said so.
        const denied = Object.assign(new Error('permission denied for function candidate_review_state'), { code: '42501' });
        const unverified = await readMembershipAccess(pool('member', denied, '2'), scope);
        expect(unverified).toEqual({ role: 'member', candidateReview: true, unverified: true });
        expect(schemaNote(unverified!)).toContain('could not be verified');
        const absent = Object.assign(new Error('function rigour.candidate_review_state() does not exist'), { code: '42883' });
        expect(await readMembershipAccess(pool('member', absent, null), scope)).toEqual({ role: 'member', candidateReview: false, unverified: true });
        expect(await readMembershipAccess(pool(undefined, 'ready'), scope)).toBeUndefined();
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
