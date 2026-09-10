import { describe, expect, it } from 'vitest';
import { getTeamSemanticHealth } from './team-vector-store.js';
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
            query: async () => ({ rows: [{
                extversion: '0.8.1',
                table_ready: true,
                indexed_lessons: 12,
                missing_lessons: 3,
            }] }),
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
    });

    it('fails health checks when vector storage is incomplete', async () => {
        const pool = {
            query: async () => ({ rows: [{ extversion: null, table_ready: false }] }),
            end: async () => undefined,
        };

        await expect(getTeamSemanticHealth(pool, config)).rejects.toThrow(/vector extension/);
    });
});
