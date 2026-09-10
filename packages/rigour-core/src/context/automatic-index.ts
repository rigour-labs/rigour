import fs from 'fs-extra';
import path from 'path';
import { PatternIndexer, getDefaultIndexPath, loadPatternIndex, savePatternIndex } from '../pattern-index/indexer.js';
import type { PatternIndex } from '../pattern-index/types.js';
import { affectedDependents, buildDependencyGraph, updateDependencyGraph, type DependencyGraph } from './dependency-graph.js';
import { syncIndexToContextCache } from './index-bridge.js';

export type SemanticIndexStatus = 'disabled' | 'warming' | 'ready' | 'degraded';

export interface AutomaticIndexStatus {
    structural: 'missing' | 'ready' | 'degraded';
    graph: 'missing' | 'ready' | 'degraded';
    semantic: SemanticIndexStatus;
    message?: string;
    updatedAt: string;
}

const enrichmentJobs = new Map<string, Promise<void>>();

function projectRelativeFiles(cwd: string, files: string[]): string[] {
    const root = path.resolve(cwd);
    return files.flatMap(file => {
        const relative = path.relative(root, path.resolve(root, file));
        if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return [];
        return [relative.split(path.sep).join('/')];
    });
}

export function mergeSemanticEmbeddings(latest: PatternIndex, enriched: PatternIndex): PatternIndex {
    const embeddings = new Map(
        enriched.patterns
            .filter(pattern => pattern.embedding?.length)
            .map(pattern => [pattern.id, pattern.embedding] as const),
    );
    return {
        ...latest,
        lastUpdated: new Date().toISOString(),
        patterns: latest.patterns.map(pattern => ({
            ...pattern,
            embedding: embeddings.get(pattern.id) ?? pattern.embedding,
        })),
    };
}

function statusPath(cwd: string): string {
    return path.join(cwd, '.rigour', 'index-status.json');
}

async function writeStatus(cwd: string, status: AutomaticIndexStatus): Promise<void> {
    await fs.ensureDir(path.join(cwd, '.rigour'));
    await fs.writeJson(statusPath(cwd), status, { spaces: 2 });
}

export async function getAutomaticIndexStatus(cwd: string): Promise<AutomaticIndexStatus> {
    try {
        return await fs.readJson(statusPath(cwd)) as AutomaticIndexStatus;
    } catch {
        return {
            structural: 'missing',
            graph: 'missing',
            semantic: 'disabled',
            updatedAt: new Date().toISOString(),
        };
    }
}

async function enrichSemantic(cwd: string, index: PatternIndex): Promise<void> {
    const indexPath = getDefaultIndexPath(cwd);
    try {
        await writeStatus(cwd, {
            structural: 'ready', graph: 'ready', semantic: 'warming', updatedAt: new Date().toISOString(),
        });
        const enriched = await new PatternIndexer(cwd, { useEmbeddings: true }).enrichIndex(index);
        const latest = await loadPatternIndex(indexPath) ?? index;
        const merged = mergeSemanticEmbeddings(latest, enriched);
        const embedded = merged.patterns.filter((pattern) => (pattern.embedding?.length ?? 0) > 0).length;
        await savePatternIndex(merged, indexPath);
        await syncIndexToContextCache(cwd, merged);
        await writeStatus(cwd, {
            structural: 'ready',
            graph: 'ready',
            semantic: embedded > 0 ? 'ready' : 'degraded',
            message: embedded > 0 ? `${embedded} patterns enriched` : 'Local embedding model unavailable; text matching remains active.',
            updatedAt: new Date().toISOString(),
        });
    } catch (error) {
        await writeStatus(cwd, {
            structural: 'ready',
            graph: 'ready',
            semantic: 'degraded',
            message: error instanceof Error ? error.message : String(error),
            updatedAt: new Date().toISOString(),
        });
    } finally {
        enrichmentJobs.delete(path.resolve(cwd));
    }
}

function startEnrichment(cwd: string, index: PatternIndex): void {
    const key = path.resolve(cwd);
    if (enrichmentJobs.has(key)) return;
    const job = enrichSemantic(cwd, index);
    enrichmentJobs.set(key, job);
}

export async function ensureAutomaticIndex(
    cwd: string,
    options: { backgroundSemantic?: boolean } = {},
): Promise<PatternIndex> {
    const indexPath = getDefaultIndexPath(cwd);
    const existing = await loadPatternIndex(indexPath);
    const indexer = new PatternIndexer(cwd, { useEmbeddings: false });
    const index = existing ?? await indexer.buildIndex();

    if (!existing) await savePatternIndex(index, indexPath);
    await syncIndexToContextCache(cwd, index);
    if (!(await fs.pathExists(path.join(cwd, '.rigour', 'dependency-graph.json')))) {
        await buildDependencyGraph(cwd, index);
    }

    const hasEmbeddings = index.patterns.some((pattern) => (pattern.embedding?.length ?? 0) > 0);
    await writeStatus(cwd, {
        structural: 'ready',
        graph: 'ready',
        semantic: hasEmbeddings ? 'ready' : options.backgroundSemantic === false ? 'disabled' : 'warming',
        updatedAt: new Date().toISOString(),
    });
    if (!hasEmbeddings && options.backgroundSemantic !== false) startEnrichment(cwd, index);
    return index;
}

export async function updateAutomaticIndexForFiles(cwd: string, changedFiles: string[]): Promise<{ index: PatternIndex; affectedFiles: string[] }> {
    const normalizedChangedFiles = projectRelativeFiles(cwd, changedFiles);
    const existing = await loadPatternIndex(getDefaultIndexPath(cwd));
    if (!existing) return { index: await ensureAutomaticIndex(cwd), affectedFiles: normalizedChangedFiles };
    const previousStatus = await getAutomaticIndexStatus(cwd);
    let graph: DependencyGraph | null = null;
    try { graph = await fs.readJson(path.join(cwd, '.rigour', 'dependency-graph.json')); } catch { /* baseline below */ }
    const affectedFiles = graph ? affectedDependents(graph, normalizedChangedFiles) : normalizedChangedFiles;
    const indexer = new PatternIndexer(cwd, { useEmbeddings: false });
    const index = await indexer.updateFiles(existing, affectedFiles);
    await savePatternIndex(index, getDefaultIndexPath(cwd));
    await syncIndexToContextCache(cwd, index);
    if (graph) await updateDependencyGraph(cwd, index, graph, affectedFiles);
    else await buildDependencyGraph(cwd, index);
    await writeStatus(cwd, {
        structural: 'ready', graph: 'ready',
        semantic: index.patterns.some(pattern => (pattern.embedding?.length ?? 0) > 0)
            ? 'ready'
            : previousStatus.semantic === 'disabled' ? 'disabled' : 'warming',
        message: `${normalizedChangedFiles.length} changed file(s); ${affectedFiles.length} affected file(s) refreshed without a full scan.`,
        updatedAt: new Date().toISOString(),
    });
    if (previousStatus.semantic !== 'disabled') startEnrichment(cwd, index);
    return { index, affectedFiles };
}
