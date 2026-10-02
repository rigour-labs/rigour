/**
 * Lessons from fixes: when an agent fixes a finding Rigour reported, that fix
 * becomes evidence for a lesson of kind `fix`, one per kind of defect.
 *
 * A lesson starts as a personal candidate and is validated by evidence alone:
 * fixes of the same kind landing in two different files make it a pattern
 * rather than a one-off (a repeat fix in one file may be the same bug
 * reintroduced). Validated lessons are what team knowledge search serves and
 * what pgvector embeds; a person can still promote one to the whole team.
 */
import { randomUUID } from 'crypto';
import type { ResolvedFix } from '../review/agent-fixes.js';
import { openDatabase } from './db.js';
import { decryptLocalPayload, encryptLocalPayload } from './local-encryption.js';
import { getRepositoryId, queueLessonSync, registerRepository, txSafeLesson } from './lessons.js';
import { loadTeamConfiguration } from './team-store.js';

/** Distinct files a kind of fix must reach before its lesson is validated. */
export const FILES_TO_VALIDATE = 2;
/** Example fixes kept per lesson; older ones still count through `files`. */
const MAX_EXAMPLES = 5;

interface FixEvidence {
    rule: string;
    files: string[];
    examples: Array<{ fixId: string; file: string; details?: string; resolvedAt: string }>;
}

/** Groups fixes of one kind of defect: every lesson subject starts with it. */
export function fixLessonPrefix(fix: Pick<ResolvedFix, 'rule' | 'title'>): string {
    return `Fixed before: ${fix.title?.trim() || fix.rule} (${fix.rule}).`;
}

/**
 * What a lesson says, and what it is embedded and matched by: the kind of defect, then what was
 * wrong in the first fix. The detail is what lets a task match it by meaning (a direct match
 * scored 0.37 with it and 0.05 with the title alone).
 */
export function fixLessonSubject(fix: Pick<ResolvedFix, 'rule' | 'title' | 'details'>): string {
    const detail = fix.details?.trim().split(/(?<=[.!?])\s/)[0]?.slice(0, 240);
    return detail ? `${fixLessonPrefix(fix)} ${detail}` : fixLessonPrefix(fix);
}

/** Record resolved fixes as lesson evidence. Returns the ids of lessons created or updated. */
export async function recordFixLessons(cwd: string, fixes: ResolvedFix[]): Promise<string[]> {
    if (fixes.length === 0) return [];
    const db = await openDatabase();
    if (!db) return [];
    try {
        const repositoryId = await getRepositoryId(cwd);
        await registerRepository(db, cwd, repositoryId);
        const config = await loadTeamConfiguration();
        const ids: string[] = [];
        for (const fix of fixes) ids.push(await recordOne(db, repositoryId, fix, config));
        return [...new Set(ids)];
    } finally {
        await db.close();
    }
}

async function recordOne(db: any, repositoryId: string, fix: ResolvedFix, config: Awaited<ReturnType<typeof loadTeamConfiguration>>): Promise<string> {
    const subject = fixLessonSubject(fix);
    const now = Date.now();
    const row = await db.get(
        `SELECT id, evidence_json FROM lessons WHERE repository_id = ? AND kind = 'fix' AND substr(subject, 1, ?) = ?`,
        repositoryId, fixLessonPrefix(fix).length, fixLessonPrefix(fix),
    );
    const prior: FixEvidence = row ? await decryptLocalPayload(row.evidence_json) as FixEvidence : { rule: fix.rule, files: [], examples: [] };
    if (prior.examples.some(e => e.fixId === fix.id)) return row.id;
    const evidence: FixEvidence = {
        rule: fix.rule,
        files: [...new Set([...prior.files, fix.file])],
        examples: [{ fixId: fix.id, file: fix.file, details: fix.details?.slice(0, 300), resolvedAt: fix.resolvedAt }, ...prior.examples].slice(0, MAX_EXAMPLES),
    };
    const validated = evidence.files.length >= FILES_TO_VALIDATE;
    const confidence = validated ? 0.8 : 0.4;
    const id = row?.id ?? `lesson-${randomUUID()}`;
    if (row) {
        await db.run(
            `UPDATE lessons SET state = CASE WHEN state IN ('promoted', 'rejected') THEN state ELSE ? END,
                evidence_json = ?, confidence = MAX(confidence, ?), updated_at = ? WHERE id = ?`,
            validated ? 'validated' : 'candidate', await encryptLocalPayload(evidence), confidence, now, id,
        );
    } else {
        await db.run(
            `INSERT INTO lessons (
                id, repository_id, actor_id, team_id, visibility, state, kind, subject,
                evidence_json, confidence, source, created_at, updated_at
            ) VALUES (?, ?, ?, ?, 'personal', ?, 'fix', ?, ?, ?, 'agent-fix', ?, ?)`,
            id, repositoryId, config?.actorId || process.env.RIGOUR_ACTOR_ID || null,
            config?.teamId || process.env.RIGOUR_TEAM_ID || null, validated ? 'validated' : 'candidate',
            subject, await encryptLocalPayload(evidence), confidence, now, now,
        );
    }
    if (config) {
        const lesson = await txSafeLesson(db, id);
        if (lesson) await queueLessonSync(db, lesson, now);
    }
    return id;
}

