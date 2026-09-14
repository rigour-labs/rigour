import { decryptLocalPayload } from './local-encryption.js';
import type { LessonRecord, LessonState, LessonVisibility } from './lessons.js';

export async function lessonRowToRecord(row: Record<string, unknown>): Promise<LessonRecord> {
    return {
        id: String(row.id),
        repositoryId: String(row.repository_id),
        actorId: row.actor_id ? String(row.actor_id) : undefined,
        teamId: row.team_id ? String(row.team_id) : undefined,
        visibility: row.visibility as LessonVisibility,
        state: row.state as LessonState,
        kind: String(row.kind),
        subject: String(row.subject),
        evidence: await decryptLocalPayload<Record<string, unknown>>(String(row.evidence_json)),
        confidence: Number(row.confidence),
        source: String(row.source),
        supersedesId: row.supersedes_id ? String(row.supersedes_id) : undefined,
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at),
        repositoryName: row.repository_name ? String(row.repository_name) : undefined,
    };
}
