import { describe, expect, it } from 'vitest';
import { buildEngineeringKnowledgeGraph } from './engineering-knowledge-graph.js';

describe('engineering knowledge graph', () => {
    it('connects code, agent outcomes and cross-repository lessons', () => {
        const graph = buildEngineeringKnowledgeGraph({
            repository: { id: 'repo-a', name: 'payments' },
            dependencyGraph: { version: 1, generatedAt: '', nodes: ['src/a.ts', 'src/b.ts'], edges: [{ from: 'src/a.ts', to: 'src/b.ts' }] },
            events: [],
            runs: [{ id: 'run-1', agentId: 'agent-1', startedAt: '', endedAt: '', status: 'success', eventCount: 2, files: ['src/a.ts'], tools: ['check'] }],
            lessons: [{ id: 'lesson-1', repositoryId: 'repo-b', repositoryName: 'platform', visibility: 'team', state: 'promoted', kind: 'interaction', subject: 'Use bounded retries', evidence: {}, confidence: 0.9, source: 'mcp', createdAt: 1, updatedAt: 1 }],
            patterns: [{ id: 'pattern-1', name: 'withTransaction', type: 'function', file: 'src/a.ts', usageCount: 8 }],
            memories: [{ id: 'memory-1', label: 'migration-owner', source: 'project' }],
        });

        expect(graph.counts.repository).toBe(2);
        expect(graph.nodes.some(node => node.type === 'outcome' && node.label === 'success')).toBe(true);
        expect(graph.edges.some(edge => edge.type === 'imports')).toBe(true);
        expect(graph.edges.some(edge => edge.type === 'produced')).toBe(true);
        expect(graph.nodes.some(node => node.type === 'pattern')).toBe(true);
        expect(graph.nodes.some(node => node.type === 'memory')).toBe(true);
    });

    it('represents prevented agent actions as policy evidence', () => {
        const graph = buildEngineeringKnowledgeGraph({
            repository: { id: 'repo-a', name: 'payments' },
            events: [{ id: 'event-1', timestamp: '', type: 'tool_denied', agentId: 'agent-1', outcome: 'rejected', files: [], summary: 'write denied' }],
            runs: [],
            lessons: [],
        });

        expect(graph.nodes).toContainEqual(expect.objectContaining({ type: 'policy', state: 'active' }));
        expect(graph.nodes).toContainEqual(expect.objectContaining({ type: 'outcome', state: 'verified' }));
        expect(graph.edges.some(edge => edge.type === 'protects')).toBe(true);
    });

    it('connects issued advice to its run and supporting knowledge', () => {
        const event = {
            id: 'event-1', requestId: 'run-1', timestamp: '2026-01-01T00:00:00Z', type: 'tool_response',
            agentId: 'agent-1', outcome: 'success' as const, files: ['src/a.ts'], summary: 'scope returned',
            guidance: {
                kind: 'context-scope' as const,
                recommendation: 'Read only src/a.ts.',
                patternRefs: [{ id: 'pattern-1', label: 'withTransaction' }],
                lessonRefs: [], memoryRefs: [], selectedFiles: ['src/a.ts'], excludedFileCount: 9, conflicts: 0,
            },
            telemetry: {
                candidateTokens: 1200, returnedTokens: 200, candidateFiles: 10, returnedFiles: 1,
                cacheStatus: 'exact-hit', classification: 'measured estimate' as const,
            },
        };
        const graph = buildEngineeringKnowledgeGraph({
            repository: { id: 'repo-a', name: 'payments' },
            dependencyGraph: { version: 1, generatedAt: '', nodes: ['src/a.ts'], edges: [] },
            events: [event],
            runs: [{ id: 'run-1', agentId: 'agent-1', startedAt: event.timestamp, endedAt: event.timestamp, status: 'success', eventCount: 1, files: ['src/a.ts'], tools: ['rigour_context_scope'] }],
            lessons: [],
            patterns: [{ id: 'pattern-1', name: 'withTransaction', type: 'function', file: 'src/a.ts' }],
        });

        expect(graph.nodes).toContainEqual(expect.objectContaining({ type: 'advice', evidence: expect.objectContaining({ avoidedTokens: 1000 }) }));
        expect(graph.edges).toContainEqual(expect.objectContaining({ from: 'run:run-1', to: 'advice:run-1', type: 'guided' }));
        expect(graph.edges).toContainEqual(expect.objectContaining({ from: 'pattern:pattern-1', to: 'advice:run-1', type: 'informed' }));
    });
});
