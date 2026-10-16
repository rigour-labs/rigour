import { describe, expect, it } from 'vitest';
import { decidesTeammatesCandidates, readMembershipAccess, recordTeamAccess, sentActorOf, widensAccess } from './team-access.js';
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

    it('reads the role and candidate review from the membership row, and nothing without one', async () => {
        const pool = (rows: any[]) => ({ query: async () => ({ rowCount: rows.length, rows }) });
        expect(await readMembershipAccess(pool([{ role: 'member', candidate_review_version: '1', member_candidates_version: '1' }]), scope))
            .toEqual({ role: 'member', candidateReview: true, memberCandidates: true });
        expect(await readMembershipAccess(pool([{ role: 'owner', candidate_review_version: null, member_candidates_version: null }]), scope))
            .toEqual({ role: 'owner', candidateReview: false, memberCandidates: false });
        expect(await readMembershipAccess(pool([]), scope)).toBeUndefined();
    });

    it('widens once: the first sync that may read members\' candidates pulls from the start, later ones from their mark', async () => {
        const db = meta();
        const sme = { role: 'sme' as const, candidateReview: true };
        await recordTeamAccess(db, scope, { role: 'sme', candidateReview: false });
        expect(await widensAccess(db, scope, sme)).toBe(true);
        await recordTeamAccess(db, scope, sme);
        expect(await widensAccess(db, scope, sme)).toBe(false);
        expect(await widensAccess(meta(), scope, { role: 'member', candidateReview: true })).toBe(false);
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
