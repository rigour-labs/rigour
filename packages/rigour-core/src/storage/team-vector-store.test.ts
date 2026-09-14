import { describe, expect, it, vi } from 'vitest';
import { getTeamSemanticHealth, upsertTeamLessonEmbedding } from './team-vector-store.js';
import type { TeamConfiguration } from './team-store.js';

const config: TeamConfiguration = {
    organizationId: 'acme',
    teamId: 'platform',
    actorId: 'alice',
    databaseUrl: 'postgresql://localhost/rigour',
    semantic: {
        provider: 'pgvector',
        model: 'Xenova/all-MiniLM-L6-v2',
        dimensions: 384,
    },
};

describe('pgvector team health', () => {
    it('reports extension, model, and embedding coverage', async () => {
        const pool = {
            query: vi.fn(async () => ({ rows: [{
                extversion: '0.8.1',
                table_ready: true,
                indexed_lessons: 12,
                missing_lessons: 3,
            }] })),
            end: async () => undefined,
        };

        await expect(getTeamSemanticHealth(pool, config)).resolves.toEqual({
            provider: 'pgvector',
            status: 'ready',
            extensionVersion: '0.8.1',
            model: 'Xenova/all-MiniLM-L6-v2',
            dimensions: 384,
            indexedLessons: 12,
            missingLessons: 3,
        });
        expect(pool.query).toHaveBeenCalledWith(
            expect.stringContaining("lesson.state IN ('validated', 'promoted')"),
            ['acme', 'platform', 'Xenova/all-MiniLM-L6-v2', 'alice'],
        );
    });

    it('fails health checks when vector storage is incomplete', async () => {
        const pool = {
            query: async () => ({ rows: [{ extversion: null, table_ready: false }] }),
            end: async () => undefined,
        };

        await expect(getTeamSemanticHealth(pool, config)).rejects.toThrow(/vector extension/);
    });

    it('does not embed unvalidated candidate lessons', async () => {
        const pool = { query: vi.fn(), end: async () => undefined };
        await expect(upsertTeamLessonEmbedding(pool, config, {
            id: 'candidate-1',
            repositoryId: 'repo-1',
            actorId: 'alice',
            kind: 'interaction',
            subject: 'Unverified suggestion',
            source: 'mcp',
            state: 'candidate',
        })).resolves.toBe(false);
        expect(pool.query).not.toHaveBeenCalled();
    });
});
