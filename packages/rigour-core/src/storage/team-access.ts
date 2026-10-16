/**
 * What this person may do with team candidates, as the last team sync read it from the team database: their role,
 * whether the database lets an sme or owner see and decide on every member's candidates (`candidate_review_version` 1)
 * and whether it lets a member propose one (`member_candidates_version` 1), both written by `init-schema`. Kept in the
 * local store's meta, so Studio reads it without connecting.
 */
import { openDatabase } from './db.js';

export type TeamRole = 'member' | 'sme' | 'owner';

export interface TeamAccess {
    role?: TeamRole;
    /** The database has the rules that let an sme or owner read and write every team row of their team. */
    candidateReview: boolean;
    /** The database lets a member write team candidates of their own (absent from what a sync before 7.0.11 recorded). */
    memberCandidates?: boolean;
}

interface TeamScope { organizationId: string; teamId: string; actorId: string }

interface Pool { query(sql: string, params?: unknown[]): Promise<{ rowCount: number | null; rows: any[] }> }

interface Meta {
    get(sql: string, ...params: unknown[]): Promise<any>;
    run(sql: string, ...params: unknown[]): Promise<unknown>;
}

/** The command an owner runs to apply the team schema again, which adds both version keys and their rules. */
export const REAPPLY_TEAM_SCHEMA = 'rigour team init-schema --database-url <administrator url>';

/** Said wherever the database lacks either key: what holds until an owner applies the schema again. */
export const TEAM_SCHEMA_UPGRADE = `Until an owner applies the team schema again (${REAPPLY_TEAM_SCHEMA}), an sme or owner sees only their own team candidates, and the database refuses a member's team memories.`;

/** Whether the database lacks the candidate rules of this version: an owner runs init-schema again. */
export function needsSchemaUpgrade(access: TeamAccess): boolean {
    return !access.candidateReview || !access.memberCandidates;
}

function accessKey(scope: TeamScope): string {
    return `team_access:${scope.organizationId}/${scope.teamId}/${scope.actorId}`;
}

function isTeamRole(value: unknown): value is TeamRole {
    return value === 'member' || value === 'sme' || value === 'owner';
}

/** Whether `access` lets this person decide on a teammate's team candidate: unknown (no sync yet) is undefined. */
export function decidesTeammatesCandidates(access: TeamAccess | undefined): boolean | undefined {
    if (!access?.role) return undefined;
    return access.candidateReview && (access.role === 'sme' || access.role === 'owner');
}

/**
 * The actor a sent lesson is written under: null for the membership's own, except for an sme or owner sending a team
 * row of another member's (a candidate they share or drop) on a database with candidate review, which keeps its author.
 */
export function sentActorOf(lesson: { visibility?: string; actorId?: string }, access: TeamAccess, ownActorId: string): string | null {
    if (!decidesTeammatesCandidates(access) || lesson.visibility !== 'team') return null;
    return lesson.actorId && lesson.actorId !== ownActorId ? lesson.actorId : null;
}

/**
 * This login's membership for `scope`, with its role and whether the database has candidate review; undefined when it
 * has no membership row there.
 */
export async function readMembershipAccess(pool: Pool, scope: TeamScope): Promise<TeamAccess | undefined> {
    const result = await pool.query(
        `SELECT membership.role,
                (SELECT value FROM rigour.meta WHERE key = 'candidate_review_version') AS candidate_review_version,
                (SELECT value FROM rigour.meta WHERE key = 'member_candidates_version') AS member_candidates_version
           FROM rigour.memberships membership
          WHERE membership.db_role = current_user AND membership.team_id = $1
            AND membership.actor_id = $2 AND membership.organization_id = $3`,
        [scope.teamId, scope.actorId, scope.organizationId],
    );
    if (result.rowCount !== 1) return undefined;
    const row = result.rows[0] ?? {};
    return {
        ...(isTeamRole(row.role) ? { role: row.role } : {}),
        candidateReview: row.candidate_review_version === '1',
        memberCandidates: row.member_candidates_version === '1',
    };
}

/**
 * Whether `access` widens what this login reads since the last recorded sync: it decides on members' candidates now
 * and did not then (a new role, or a schema an owner just applied again). The pull then reads the team from the start,
 * since the candidates it could not read before are older than its last pull.
 */
export async function widensAccess(db: Meta, scope: TeamScope, access: TeamAccess): Promise<boolean> {
    return decidesTeammatesCandidates(access) === true && decidesTeammatesCandidates(await recordedAccess(db, scope)) !== true;
}

/** Recorded once a sync has pulled, so a sync that fails before then reads from the start again next time. */
export async function recordTeamAccess(db: Meta, scope: TeamScope, access: TeamAccess): Promise<void> {
    await db.run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', accessKey(scope), JSON.stringify(access));
}

async function recordedAccess(db: Meta, scope: TeamScope): Promise<TeamAccess | undefined> {
    try {
        const value = (await db.get('SELECT value FROM meta WHERE key = ?', accessKey(scope)))?.value;
        const parsed = value ? JSON.parse(String(value)) : undefined;
        return parsed && typeof parsed.candidateReview === 'boolean'
            ? {
                ...(isTeamRole(parsed.role) ? { role: parsed.role } : {}),
                candidateReview: parsed.candidateReview,
                ...(typeof parsed.memberCandidates === 'boolean' ? { memberCandidates: parsed.memberCandidates } : {}),
            }
            : undefined;
    } catch {
        return undefined;
    }
}

/** What the last sync on this machine read for `scope`; undefined before the first one, or without a local store. */
export async function readTeamAccess(scope: TeamScope): Promise<TeamAccess | undefined> {
    const db = await openDatabase().catch(() => null);
    if (!db) return undefined;
    try {
        return await recordedAccess(db, scope);
    } finally {
        await db.close();
    }
}
