/**
 * Shares a person's decisions on review lessons with their team (rigour.review_decisions), so every teammate's brief
 * is the same. Read from the repository's lessons store, which stays the source of truth: nothing is queued at the
 * moment of deciding, so a decision made offline, or before team mode, is sent on the next sync all the same.
 *
 * What a row carries, and nothing more: the lesson's id, the kind of decision, when, the reason, and per kind the
 * approved wording (accepted, reworded, a compiled check approved), the scope, the file and folder as hashes, and the
 * review points it was learned from as pull request, comment id, person or bot, and the reviewer as a salted hash.
 * Never a path, a login, code, or a review comment's text.
 */
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { lessonsPath, readLessons, type LessonEvidence, type ReviewLesson } from '../review-learning/lessons.js';
import { repositoryAllowed, type TeamScope } from './team-scope.js';

/** A person's decisions that are shared. A correction is not: it is learned from the person's own edit, and its text is the code they changed. */
const SHARED_KINDS = new Set<LessonEvidence['kind']>(['accepted', 'rejected', 'dismissed', 'scoped', 'reworded', 'compiled']);
/** Decisions whose row carries the lesson's wording: what a person approved as a team rule. */
const CARRIES_TEXT = new Set<LessonEvidence['kind']>(['accepted', 'reworded', 'compiled']);
const MAX_TEXT = 400;
const MAX_DETAIL = 500;
/** At most this many rows a sync, so a first sync of a large store is spread over several. */
const MAX_ROWS = 200;

export interface DecisionRow {
    lessonId: string;
    kind: string;
    decidedAt: string;
    detail: string;
    clientKey: string;
    payload: {
        text?: string;
        scope?: 'file' | 'folder' | 'repo';
        file?: string;
        folder?: string;
        points: Array<{ pr: number; comment: string; source: 'person' | 'bot'; reviewer: string; postedAt?: string }>;
    };
}

const sha256 = (...parts: string[]) => createHash('sha256').update(parts.join('\u0000')).digest('hex');

/** A compiled check taken back is a decision too, but its lesson's wording was not approved by it. */
function carriesText(e: LessonEvidence): boolean {
    return CARRIES_TEXT.has(e.kind) && !(e.kind === 'compiled' && /^took back/.test(e.detail ?? ''));
}

/** The reason as the person gave it. A rewording's "; was: <old wording>" is dropped: the old wording was never approved. */
function reason(e: LessonEvidence): string {
    const detail = e.kind === 'reworded' ? (e.detail ?? '').split('; was: ')[0] : e.detail ?? '';
    return detail.slice(0, MAX_DETAIL);
}

/** The scope a `scoped` decision set, from its detail (`repo` or `repo: why`). */
function scopeOf(e: LessonEvidence): 'file' | 'folder' | 'repo' | undefined {
    return /^(file|folder|repo)\b/.exec(e.detail ?? '')?.[1] as 'file' | 'folder' | 'repo' | undefined;
}

/** When the decision was made: its own time, else the lesson's last change. Undefined when neither is a time. */
function decidedAt(e: LessonEvidence, lesson: ReviewLesson): string | undefined {
    for (const at of [e.at, lesson.updatedAt]) if (at && !Number.isNaN(Date.parse(at))) return new Date(at).toISOString();
    return undefined;
}

/**
 * The rows `person` may share from these lessons: their own decisions only (a decision is never sent under someone
 * else's name), of the shared kinds. Pure: the same store gives the same rows and keys, so a resend is a no-op.
 */
export function decisionRows(lessons: ReviewLesson[], context: { repositoryId: string; person: string; salt: string }): DecisionRow[] {
    const rows: DecisionRow[] = [];
    for (const lesson of lessons) {
        const points = lesson.evidence.filter(e => (e.kind ?? 'point') === 'point').map(e => ({
            pr: e.pr, comment: e.comment, source: e.source === 'bot' ? 'bot' as const : 'person' as const,
            reviewer: sha256(context.salt, e.author), ...(e.at ? { postedAt: e.at } : {}),
        }));
        for (const e of lesson.evidence) {
            const kind = e.kind;
            if (!kind || !SHARED_KINDS.has(kind) || e.author !== context.person) continue;
            const at = decidedAt(e, lesson);
            if (!at) continue;
            const scope = e.kind === 'scoped' ? scopeOf(e) : undefined;
            rows.push({
                lessonId: lesson.id,
                kind,
                decidedAt: at,
                detail: reason(e),
                clientKey: sha256(context.repositoryId, lesson.id, kind, e.comment, context.person),
                payload: {
                    ...(carriesText(e) ? { text: lesson.text.slice(0, MAX_TEXT) } : {}),
                    ...(scope ? { scope } : {}),
                    ...(lesson.file ? { file: sha256(context.repositoryId, lesson.file) } : {}),
                    ...(scope === 'folder' && lesson.file ? { folder: sha256(context.repositoryId, path.posix.dirname(lesson.file)) } : {}),
                    points,
                },
            });
        }
    }
    return rows;
}

/** The database calls pushReviewDecisions makes; a pg Pool satisfies it. */
export interface DecisionPool {
    query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
}
/** The local calls it makes; the SQLite cache satisfies it. */
export interface DecisionCache {
    get(sql: string, ...params: unknown[]): Promise<any>;
    all(sql: string, ...params: unknown[]): Promise<any[]>;
    run(sql: string, ...params: unknown[]): Promise<unknown>;
}

export interface DecisionPush {
    sent: number;
    refused: number;
    /** Why nothing was sent from this repository, when nothing could be. */
    held?: string;
}

/** Postgres refused the row itself: row-level security or a constraint. It would refuse it every time. */
function refusedRow(error: unknown): boolean {
    const code = (error as { code?: unknown })?.code;
    return typeof code === 'string' && (code === '42501' || code.startsWith('23'));
}

/**
 * Sends this repository's decisions by `person` that were not sent before. Called by the team sync with the
 * repository it runs in. Reads the store only when it changed since the last push (size and modification time).
 */
export async function pushReviewDecisions(pool: DecisionPool, cache: DecisionCache, input: {
    cwd: string;
    origin: string | undefined;
    repositoryId: string;
    person: string;
    scope: TeamScope & { teamId: string; actorId: string };
}): Promise<DecisionPush> {
    const { cwd, origin, repositoryId, person, scope } = input;
    if (!origin) return { sent: 0, refused: 0, held: 'repository has no origin remote' };
    if (!repositoryAllowed(origin, scope)) return { sent: 0, refused: 0, held: 'repository is not one of the team\'s repositories' };
    const store = fs.statSync(lessonsPath(cwd), { throwIfNoEntry: false });
    if (!store) return { sent: 0, refused: 0 };
    const mark = `review_decisions_pushed:${scope.organizationId}/${scope.teamId}/${repositoryId}`;
    const stamp = `${store.size}:${store.mtimeMs}`;
    if ((await cache.get('SELECT value FROM meta WHERE key = ?', mark))?.value === stamp) return { sent: 0, refused: 0 };

    if (!person || person === 'unknown') return { sent: 0, refused: 0, held: 'no git user.email here, so no decision can be told apart as yours' };
    // The version first: a database from before review decisions has no salts table to read.
    const version = await pool.query(`SELECT value FROM rigour.meta WHERE key = 'review_decisions_version'`);
    if (version.rows[0]?.value !== '1') return { sent: 0, refused: 0, held: 'the team database has no review decisions yet: run rigour team init-schema' };
    const membership = await pool.query(
        `SELECT membership.role, salts.salt
         FROM rigour.memberships membership
         LEFT JOIN rigour.organization_salts salts ON salts.organization_id = membership.organization_id
         WHERE membership.db_role = current_user AND membership.organization_id = $1 AND membership.team_id = $2 AND membership.actor_id = $3`,
        [scope.organizationId, scope.teamId, scope.actorId],
    );
    const row = membership.rows[0];
    if (!row?.salt) return { sent: 0, refused: 0, held: 'no membership for this login in this organization and team' };
    if (row.role !== 'sme' && row.role !== 'owner') return { sent: 0, refused: 0, held: 'a member\'s decisions stay on this machine: an sme or owner shares them' };

    const rows = decisionRows(readLessons(cwd), { repositoryId, person, salt: row.salt });
    const known = new Set((await cache.all('SELECT client_key FROM review_decisions_sent WHERE repository_id = ?', repositoryId)).map(r => r.client_key));
    const unsent = rows.filter(r => !known.has(r.clientKey));
    let sent = 0;
    let refused = 0;
    for (const decision of unsent.slice(0, MAX_ROWS)) {
        let outcome = 'sent';
        try {
            await pool.query(
                `INSERT INTO rigour.review_decisions (organization_id, team_id, repository_id, lesson_id, kind, actor_id, client_key, decided_at, detail, payload)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
                 ON CONFLICT (organization_id, team_id, client_key) DO NOTHING`,
                [scope.organizationId, scope.teamId, repositoryId, decision.lessonId, decision.kind, scope.actorId, decision.clientKey, decision.decidedAt, decision.detail, JSON.stringify(decision.payload)],
            );
            sent++;
        } catch (error) {
            // A refused row is refused every time: it is set aside with the reason. Anything else stops the push and
            // the rest is tried on the next sync.
            if (!refusedRow(error)) throw error;
            outcome = `refused by the team database: ${String((error as Error)?.message ?? error).slice(0, 500)}`;
            refused++;
        }
        await cache.run('INSERT OR REPLACE INTO review_decisions_sent (client_key, repository_id, outcome, sent_at) VALUES (?, ?, ?, ?)', decision.clientKey, repositoryId, outcome, Date.now());
    }
    // The store is marked pushed only when everything in it went: a capped push reads it again next time.
    if (unsent.length <= MAX_ROWS) await cache.run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', mark, stamp);
    return { sent, refused };
}
