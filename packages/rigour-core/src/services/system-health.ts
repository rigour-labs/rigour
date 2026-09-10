import fs from 'fs-extra';
import path from 'path';
import { getAutomaticIndexStatus } from '../context/automatic-index.js';
import { getDefaultIndexPath, loadPatternIndex } from '../pattern-index/indexer.js';
import { listContextCacheRecords } from '../storage/context-telemetry.js';
import { countInteractionEvidence, listLessons } from '../storage/lessons.js';
import { getTeamModeStatus } from '../storage/team-store.js';

export interface SystemHealth {
    schemaVersion: 1;
    generatedAt: string;
    index: { status: string; patterns: number; files: number; updatedAt?: string };
    graph: { status: string; nodes: number; edges: number; updatedAt?: string };
    semantic: { status: string; provider: 'local' | 'pgvector'; message?: string };
    caches: { status: string; layers: Record<'static' | 'component' | 'semantic' | 'checkpoint', number> };
    learning: { status: string; total: number; observations: number; states: Record<string, number> };
    storage: Awaited<ReturnType<typeof getTeamModeStatus>>;
}

export async function getSystemHealth(cwd: string): Promise<SystemHealth> {
    const [automatic, index, cacheRecords, lessons, observations, storage, graph] = await Promise.all([
        getAutomaticIndexStatus(cwd),
        loadPatternIndex(getDefaultIndexPath(cwd)).catch(() => null),
        listContextCacheRecords({ limit: 10_000 }, cwd).catch(() => []),
        listLessons(cwd, 10_000).catch(() => []),
        countInteractionEvidence(cwd).catch(() => 0),
        getTeamModeStatus(),
        fs.readJson(path.join(cwd, '.rigour', 'dependency-graph.json')).catch(() => null),
    ]);
    const layers = { static: 0, component: 0, semantic: 0, checkpoint: 0 };
    for (const record of cacheRecords) layers[record.cacheType]++;
    const states: Record<string, number> = {};
    for (const lesson of lessons) states[lesson.state] = (states[lesson.state] ?? 0) + 1;
    const graphNodes = Array.isArray(graph?.nodes) ? graph.nodes.length : 0;
    const graphEdges = Array.isArray(graph?.edges) ? graph.edges.length : 0;
    return {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        index: {
            status: index ? automatic.structural : 'missing',
            patterns: index?.stats?.totalPatterns ?? index?.patterns?.length ?? 0,
            files: index?.stats?.totalFiles ?? 0,
            updatedAt: index?.lastUpdated,
        },
        graph: { status: graph ? automatic.graph : 'missing', nodes: graphNodes, edges: graphEdges, updatedAt: graph?.generatedAt },
        semantic: storage.semantic
            ? {
                status: storage.semantic.status,
                provider: 'pgvector',
                message: storage.semantic.status === 'ready'
                    ? `pgvector · ${storage.semantic.indexedLessons ?? 0} lessons indexed${storage.semantic.missingLessons ? ` · ${storage.semantic.missingLessons} pending` : ''}`
                    : storage.semantic.message,
            }
            : {
                status: automatic.semantic,
                provider: 'local',
                message: automatic.message ?? (automatic.semantic === 'ready' ? 'Local pattern embeddings ready.' : undefined),
            },
        caches: { status: Object.values(layers).every(count => count > 0) ? 'ready' : 'warming', layers },
        learning: { status: observations || lessons.length ? 'active' : 'idle', total: lessons.length, observations, states },
        storage,
    };
}
