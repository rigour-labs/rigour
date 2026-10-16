/**
 * What this person may do with team candidates, as the last team sync read it from the team database: their role, and
 * whether this version's candidate rules are in force there (team-lesson-rules.ts), as rigour.candidate_review_state()
 * reads them: `candidate_review_version` 2 and the lessons_*_v2 policies, with no older init-schema's put back.
 * Kept in the local store's meta, so Studio reads it without connecting.
 */
import { openDatabase } from './db.js';

export type TeamRole = 'member' | 'sme' | 'owner';

export interface TeamAccess {
    role?: TeamRole;
    /**
     * This version's candidate rules are in force: an sme or owner reads and decides on every team row of their team,
     * and a member proposes and drops team candidates of their own.
     */
    candidateReview: boolean;
    /** An older init-schema ran after this version's and put its own lessons policies back beside these. */
    olderRules?: true;
    /** Read from the version key alone: this login could not run rigour.candidate_review_state(). */
    unverified?: true;
}

interface TeamScope { organizationId: string; teamId: string; actorId: string }

interface Pool { query(sql: string, params?: unknown[]): Promise<{ rowCount: number | null; rows: any[] }> }

interface Meta {
    get(sql: string, ...params: unknown[]): Promise<any>;
    run(sql: string, ...params: unknown[]): Promise<unknown>;
}

/** The command an owner runs to apply this version's team schema, with its candidate rules. */
export const REAPPLY_TEAM_SCHEMA = 'rigour team init-schema --database-url <administrator url>';

/** Said wherever the rules are missing: what holds until an owner applies this version's schema. */
const TEAM_SCHEMA_UPGRADE = `Until an owner applies this version's team schema (${REAPPLY_TEAM_SCHEMA}), an sme or owner sees only their own team candidates, and the database refuses a member's team memories.`;

/** Said where an older init-schema put its policies back: what an owner runs, and what never to run. */
const OLDER_SCHEMA_APPLIED = `An older Rigour's init-schema ran on this team database and put its own lessons policies back beside this version's. An owner runs this version's (${REAPPLY_TEAM_SCHEMA}) again; never run an older init-schema on it.`;

/** Said where the rules could not be verified: the key says they are there, the policies could not be read. */
const RULES_NOT_VERIFIED = `The candidate rules could not be verified: this login may not run rigour.candidate_review_state(). An owner runs this version's init-schema (${REAPPLY_TEAM_SCHEMA}), which grants it to every member login.`;

/** What an owner should know about the team database's candidate rules; undefined when they are in force. */
export function schemaNote(access: TeamAccess): string | undefined {
    if (access.olderRules) return OLDER_SCHEMA_APPLIED;
    if (access.unverified && access.candidateReview) return RULES_NOT_VERIFIED;
    return access.candidateReview ? undefined : TEAM_SCHEMA_UPGRADE;
}

/**
 * Whether this version's candidate rules are in force, as rigour.candidate_review_state() says (any member login may
 * run it; it reads pg_policies, which a managed host may keep from them). A database without it, or a login not granted
 * it, falls back to the version key alone: `unverified`.
 */
export async function readCandidateRules(pool: Pool): Promise<{ ready: boolean; olderRules: boolean; unverified: boolean }> {
    try {
        const state = (await pool.query('SELECT rigour.candidate_review_state() AS state')).rows[0]?.state;
        return { ready: state === 'ready', olderRules: state === 'older rules', unverified: false };
    } catch (error) {
        const code = (error as { code?: unknown })?.code;
        if (code !== '42501' && code !== '42883') throw error; // not permitted, or no such function: read the key
        const version = (await pool.query(`SELECT value FROM rigour.meta WHERE key = 'candidate_review_version'`)).rows[0]?.value;
        return { ready: version === '2', olderRules: false, unverified: true };
    }
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
        `SELECT membership.role
           FROM rigour.memberships membership
          WHERE membership.db_role = current_user AND membership.team_id = $1
            AND membership.actor_id = $2 AND membership.organization_id = $3`,
        [scope.teamId, scope.actorId, scope.organizationId],
    );
    if (result.rowCount !== 1) return undefined;
    const row = result.rows[0] ?? {};
    const rules = await readCandidateRules(pool);
    return {
        ...(isTeamRole(row.role) ? { role: row.role } : {}),
        candidateReview: rules.ready,
        ...(rules.olderRules ? { olderRules: true as const } : {}),
        ...(rules.unverified ? { unverified: true as const } : {}),
    };
}

/**
 * How `access` changed since the last recorded sync:
 * - `widened`: it decides on members' candidates now and did not then (a new role, or a schema an owner just applied).
 *   The pull reads the team from the start: the candidates it could not read before are older than its last pull.
 * - `rulesArrived`: the candidate rules are in force now and were not then. Candidates of this person's the database
 *   refused before go again.
 * - `narrowed`: it decided on members' candidates then and does not now (a demoted sme). Their candidates leave this
 *   machine.
 */
export async function accessChange(db: Meta, scope: TeamScope, access: TeamAccess): Promise<{ widened: boolean; rulesArrived: boolean; narrowed: boolean }> {
    const before = await recordedAccess(db, scope);
    const decidesNow = decidesTeammatesCandidates(access) === true;
    const decidedThen = decidesTeammatesCandidates(before) === true;
    return { widened: decidesNow && !decidedThen, rulesArrived: access.candidateReview && before?.candidateReview !== true, narrowed: decidedThen && !decidesNow };
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
                ...(parsed.olderRules === true ? { olderRules: true as const } : {}),
                ...(parsed.unverified === true ? { unverified: true as const } : {}),
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
