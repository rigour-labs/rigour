import { createHash } from 'node:crypto';
import type {
    SemanticKnowledgeResult,
    TeamConfiguration,
    TeamModeStatus,
} from './team-store.js';

type PgPool = {
    query: (sql: string, params?: unknown[]) => Promise<any>;
    end: () => Promise<void>;
};

interface EmbeddableLesson {
    id: string;
    repositoryId?: string;
    repository_id?: string;
    actorId?: string;
    actor_id?: string;
    kind: string;
    subject: string;
    source: string;
}

export const TEAM_VECTOR_SCHEMA = `
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE IF NOT EXISTS rigour.lesson_embeddings (
    lesson_id TEXT PRIMARY KEY REFERENCES rigour.lessons(id) ON DELETE CASCADE,
    organization_id TEXT NOT NULL,
    team_id TEXT NOT NULL,
    repository_id TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    model TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    embedding vector(384) NOT NULL,
    updated_at BIGINT NOT NULL
);
ALTER TABLE rigour.lesson_embeddings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS lesson_embeddings_read ON rigour.lesson_embeddings;
CREATE POLICY lesson_embeddings_read ON rigour.lesson_embeddings FOR SELECT USING (
    EXISTS (
        SELECT 1 FROM rigour.memberships membership
        JOIN rigour.lessons lesson ON lesson.id = lesson_embeddings.lesson_id
        WHERE membership.db_role = current_user
          AND membership.organization_id = lesson_embeddings.organization_id
          AND membership.team_id = lesson_embeddings.team_id
          AND ((lesson.visibility = 'team' AND lesson.state = 'promoted')
               OR membership.actor_id = lesson.actor_id)
    )
);
DROP POLICY IF EXISTS lesson_embeddings_write ON rigour.lesson_embeddings;
CREATE POLICY lesson_embeddings_write ON rigour.lesson_embeddings FOR ALL USING (
    EXISTS (
        SELECT 1 FROM rigour.memberships membership
        WHERE membership.db_role = current_user
          AND membership.organization_id = lesson_embeddings.organization_id
          AND membership.team_id = lesson_embeddings.team_id
          AND membership.actor_id = lesson_embeddings.actor_id
    )
) WITH CHECK (
    EXISTS (
        SELECT 1 FROM rigour.memberships membership
        WHERE membership.db_role = current_user
          AND membership.organization_id = lesson_embeddings.organization_id
          AND membership.team_id = lesson_embeddings.team_id
          AND membership.actor_id = lesson_embeddings.actor_id
    )
);
CREATE INDEX IF NOT EXISTS lesson_embeddings_scope
    ON rigour.lesson_embeddings (organization_id, team_id, model);
CREATE INDEX IF NOT EXISTS lesson_embeddings_hnsw
    ON rigour.lesson_embeddings USING hnsw (embedding vector_cosine_ops);
`;

async function createPool(databaseUrl: string): Promise<PgPool> {
    try {
        const { Pool } = await import('pg');
        return new Pool({ connectionString: databaseUrl }) as unknown as PgPool;
    } catch {
        throw new Error('PostgreSQL support is unavailable. Install the optional "pg" dependency.');
    }
}

function vectorLiteral(values: number[]): string {
    if (!values.length || values.some(value => !Number.isFinite(value))) throw new Error('Embedding contains invalid values.');
    return `[${values.join(',')}]`;
}

export async function getTeamSemanticHealth(
    pool: PgPool,
    config: TeamConfiguration,
): Promise<NonNullable<TeamModeStatus['semantic']>> {
    if (!config.semantic) throw new Error('pgvector team semantics is not configured.');
    const result = await pool.query(
        `SELECT (SELECT extversion FROM pg_extension WHERE extname = 'vector') AS extversion,
                to_regclass('rigour.lesson_embeddings') IS NOT NULL AS table_ready,
                (SELECT COUNT(*)::integer FROM rigour.lesson_embeddings) AS indexed_lessons,
                (SELECT COUNT(*)::integer
                   FROM rigour.lessons lesson
                  WHERE lesson.state IN ('validated', 'promoted')
                    AND NOT EXISTS (
                        SELECT 1 FROM rigour.lesson_embeddings embedding
                        WHERE embedding.lesson_id = lesson.id
                    )) AS missing_lessons`,
    );
    const row = result.rows[0];
    if (!row?.extversion || !row?.table_ready) {
        throw new Error('pgvector semantic storage is configured but the vector extension or lesson_embeddings table is missing.');
    }
    return {
        provider: 'pgvector',
        status: 'ready',
        extensionVersion: String(row.extversion),
        model: config.semantic.model,
        dimensions: config.semantic.dimensions,
        indexedLessons: Number(row.indexed_lessons ?? 0),
        missingLessons: Number(row.missing_lessons ?? 0),
    };
}

export async function upsertTeamLessonEmbedding(
    pool: PgPool,
    config: TeamConfiguration,
    lesson: EmbeddableLesson,
): Promise<boolean> {
    if (!config.semantic) return false;
    const { generateEmbedding } = await import('../pattern-index/embeddings.js');
    const content = `${lesson.kind}\n${lesson.subject}\n${lesson.source}`;
    const embedding = await generateEmbedding(content);
    if (embedding.length !== config.semantic.dimensions) return false;
    await pool.query(
        `INSERT INTO rigour.lesson_embeddings (
            lesson_id, organization_id, team_id, repository_id, actor_id,
            model, content_hash, embedding, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::vector, $9)
        ON CONFLICT (lesson_id) DO UPDATE SET
            model=EXCLUDED.model, content_hash=EXCLUDED.content_hash,
            embedding=EXCLUDED.embedding, updated_at=EXCLUDED.updated_at`,
        [lesson.id, config.organizationId, config.teamId, lesson.repositoryId ?? lesson.repository_id,
            lesson.actorId ?? lesson.actor_id ?? config.actorId, config.semantic.model,
            createHash('sha256').update(content).digest('hex'), vectorLiteral(embedding), Date.now()],
    );
    return true;
}

export async function backfillConfiguredTeamEmbeddings(
    config: TeamConfiguration,
    limit: number,
): Promise<{ eligible: number; embedded: number; skipped: number }> {
    if (!config.databaseUrl || !config.semantic) throw new Error('pgvector team semantics is not configured.');
    const pool = await createPool(config.databaseUrl);
    try {
        const lessons = await pool.query(
            `SELECT lesson.id, lesson.repository_id, lesson.actor_id, lesson.kind, lesson.subject, lesson.source
               FROM rigour.lessons lesson
              WHERE lesson.organization_id = $1 AND lesson.team_id = $2
                AND lesson.actor_id = $3
                AND lesson.state IN ('validated', 'promoted')
                AND NOT EXISTS (
                    SELECT 1 FROM rigour.lesson_embeddings embedding
                    WHERE embedding.lesson_id = lesson.id AND embedding.model = $4
                )
              ORDER BY lesson.updated_at ASC LIMIT $5`,
            [config.organizationId, config.teamId, config.actorId, config.semantic.model, Math.max(1, Math.min(2_000, limit))],
        );
        let embedded = 0;
        for (const lesson of lessons.rows) {
            if (await upsertTeamLessonEmbedding(pool, config, lesson)) embedded++;
        }
        return { eligible: lessons.rows.length, embedded, skipped: lessons.rows.length - embedded };
    } finally {
        await pool.end();
    }
}

export async function searchConfiguredTeamKnowledge(
    config: TeamConfiguration,
    query: string,
    limit: number,
): Promise<SemanticKnowledgeResult> {
    if (!config.semantic || !config.databaseUrl) return { status: 'disabled', candidates: [] };
    try {
        const { generateEmbedding } = await import('../pattern-index/embeddings.js');
        const embedding = await generateEmbedding(query);
        if (embedding.length !== config.semantic.dimensions) {
            return {
                status: 'degraded', provider: 'pgvector', model: config.semantic.model, candidates: [],
                message: `Embedding model returned ${embedding.length} dimensions; expected ${config.semantic.dimensions}.`,
            };
        }
        const pool = await createPool(config.databaseUrl);
        try {
            const result = await pool.query(
                `SELECT lesson.id, lesson.repository_id, lesson.subject, lesson.visibility,
                        lesson.state, lesson.confidence, lesson.source,
                        1 - (embedding.embedding <=> $1::vector) AS similarity
                   FROM rigour.lesson_embeddings embedding
                   JOIN rigour.lessons lesson ON lesson.id = embedding.lesson_id
                  WHERE embedding.organization_id = $2 AND embedding.team_id = $3
                    AND embedding.model = $4
                    AND ((lesson.visibility = 'personal' AND lesson.actor_id = $7
                          AND lesson.state IN ('validated', 'promoted'))
                         OR (lesson.visibility = 'team' AND lesson.state = 'promoted'))
                    AND 1 - (embedding.embedding <=> $1::vector) >= $6
                  ORDER BY embedding.embedding <=> $1::vector LIMIT $5`,
                [vectorLiteral(embedding), config.organizationId, config.teamId, config.semantic.model,
                    Math.max(1, Math.min(25, limit)), 0.45, config.actorId],
            );
            return {
                status: 'ready', provider: 'pgvector', model: config.semantic.model,
                candidates: result.rows.map((row: any) => ({
                    lessonId: String(row.id), repositoryId: String(row.repository_id), subject: String(row.subject),
                    visibility: String(row.visibility), state: String(row.state), confidence: Number(row.confidence),
                    similarity: Number(row.similarity), provenance: `${row.visibility}:${row.source}:${row.id}`,
                })),
            };
        } finally {
            await pool.end();
        }
    } catch (error) {
        return {
            status: 'degraded', provider: 'pgvector', model: config.semantic.model, candidates: [],
            message: error instanceof Error ? error.message : String(error),
        };
    }
}
