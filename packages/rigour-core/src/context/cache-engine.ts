/**
 * 4-Layer Context Caching Engine for Rigour
 * 
 * Implements:
 * 1. Content-addressed static cache (AST, exports, imports, dependencies, patterns by content SHA)
 * 2. Component context cache (Compact dossiers per component scope)
 * 3. Semantic-query cache (Intent embeddings & edit/validation scopes)
 * 4. Task checkpoint cache (Subagent handoff packets)
 */

import { createHash } from 'crypto';
import fs from 'fs-extra';
import path from 'path';
import {
    setContextCacheRecord,
    getContextCacheRecord,
    listContextCacheRecords,
    ContextCacheRecord,
    recordCheckpointMetric
} from '../storage/index.js';

export interface StaticCacheEntry {
    astSummary?: any;
    exports?: string[];
    imports?: string[];
    dependencies?: string[];
    ownership?: string;
    schemas?: any[];
    endpoints?: string[];
    eventRelationships?: any[];
    styleFingerprint?: string;
    rigourPatterns?: string[];
}

export interface ComponentDossier {
    component: string;
    responsibility: string;
    canonicalFiles: string[];
    contracts: string[];
    directConsumers: string[];
    validationCommands: string[];
}

export interface SemanticQueryEntry {
    query: string;
    intentEmbedding?: number[];
    resolvedOwner: string;
    editScope: string[];
    validationScope: string[];
    evidence: string[];
    commitSha: string;
    confidence: number;
}

export interface TaskCheckpointPacket {
    taskId: string;
    agentId: string;
    phase: string;
    component: string;
    changedFiles: string[];
    decisions: string[];
    validation: string[];
    remainingWork: string[];
    risks: string[];
}

/**
 * Generate SHA-256 content hash.
 */
export function hashContent(content: string): string {
    return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

/**
 * Layer 1: Content-Addressed Static Cache
 */
export async function getStaticCache(
    repo: string,
    branch: string,
    filePath: string,
    fileContent: string,
    cwd?: string
): Promise<StaticCacheEntry | null> {
    const contentSha = hashContent(fileContent);
    const cacheKey = `static:${repo}:${branch}:${filePath}:${contentSha}:v1`;
    const record = await getContextCacheRecord(cacheKey, cwd);
    if (!record) return null;

    try {
        return JSON.parse(record.payloadJson) as StaticCacheEntry;
    } catch {
        return null;
    }
}

export async function setStaticCache(
    repo: string,
    branch: string,
    filePath: string,
    fileContent: string,
    entry: StaticCacheEntry,
    cwd?: string
): Promise<void> {
    const contentSha = hashContent(fileContent);
    const cacheKey = `static:${repo}:${branch}:${filePath}:${contentSha}:v1`;
    const payloadJson = JSON.stringify(entry);
    const payloadTokens = Math.ceil(payloadJson.length / 4);

    await setContextCacheRecord({
        cacheKey,
        cacheType: 'static',
        repo,
        branch,
        commitSha: contentSha,
        dependencyFingerprint: `sha-${contentSha}`,
        payloadJson,
        payloadTokens,
    }, cwd);
}

/**
 * Layer 2: Component Context Cache
 */
export async function getComponentCache(
    componentName: string,
    commitSha: string,
    profileVersion = '3',
    cwd?: string
): Promise<ComponentDossier | null> {
    const cacheKey = `component:${componentName}:${commitSha}:v${profileVersion}`;
    const record = await getContextCacheRecord(cacheKey, cwd);
    if (!record) return null;

    try {
        return JSON.parse(record.payloadJson) as ComponentDossier;
    } catch {
        return null;
    }
}

export async function setComponentCache(
    componentName: string,
    commitSha: string,
    dossier: ComponentDossier,
    dependencyFingerprint: string,
    profileVersion = '3',
    cwd?: string
): Promise<void> {
    const cacheKey = `component:${componentName}:${commitSha}:v${profileVersion}`;
    const payloadJson = JSON.stringify(dossier);
    const payloadTokens = Math.ceil(payloadJson.length / 4);

    await setContextCacheRecord({
        cacheKey,
        cacheType: 'component',
        repo: dossier.component,
        branch: 'main',
        commitSha,
        dependencyFingerprint,
        payloadJson,
        payloadTokens,
    }, cwd);
}

/**
 * Layer 3: Semantic-Query Cache
 */
export function normalizeQuery(query: string): string {
    return query.toLowerCase().trim().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ');
}

export async function getSemanticQueryCache(
    query: string,
    commitSha: string,
    cwd?: string
): Promise<SemanticQueryEntry | null> {
    const normalized = normalizeQuery(query);
    const queryHash = hashContent(normalized);
    const cacheKey = `semantic:${queryHash}:${commitSha}`;
    const record = await getContextCacheRecord(cacheKey, cwd);
    if (!record) return null;

    try {
        return JSON.parse(record.payloadJson) as SemanticQueryEntry;
    } catch {
        return null;
    }
}

export async function setSemanticQueryCache(
    query: string,
    commitSha: string,
    entry: SemanticQueryEntry,
    cwd?: string
): Promise<void> {
    const normalized = normalizeQuery(query);
    const queryHash = hashContent(normalized);
    const cacheKey = `semantic:${queryHash}:${commitSha}`;
    const payloadJson = JSON.stringify(entry);
    const payloadTokens = Math.ceil(payloadJson.length / 4);

    await setContextCacheRecord({
        cacheKey,
        cacheType: 'semantic',
        repo: 'workspace',
        branch: 'main',
        commitSha,
        dependencyFingerprint: `query-${queryHash}`,
        payloadJson,
        payloadTokens,
    }, cwd);
}

function queryTokenSet(query: string): Set<string> {
    return new Set(normalizeQuery(query).split(' ').filter((t) => t.length > 1));
}

/** Jaccard similarity of normalized query tokens — used for quality-safe partial reuse. */
export function queryTokenOverlap(a: string, b: string): number {
    const left = queryTokenSet(a);
    const right = queryTokenSet(b);
    if (left.size === 0 || right.size === 0) return 0;
    let inter = 0;
    for (const t of left) {
        if (right.has(t)) inter++;
    }
    const union = left.size + right.size - inter;
    return union === 0 ? 0 : inter / union;
}

/**
 * Distinctive tokens (len >= 5) must mostly agree — blocks "task service" ≈ "payment service".
 */
export function distinctiveTokenAgreement(a: string, b: string): number {
    const left = [...queryTokenSet(a)].filter((t) => t.length >= 5);
    const right = new Set([...queryTokenSet(b)].filter((t) => t.length >= 5));
    if (left.length === 0 || right.size === 0) return 0;
    const hits = left.filter((t) => right.has(t)).length;
    return hits / Math.max(left.length, right.size);
}

export interface RelatedSemanticHit {
    entry: SemanticQueryEntry;
    overlap: number;
    sourceQuery: string;
}

/**
 * Quality-safe partial semantic reuse: same commit only.
 * Requires high Jaccard (>= 0.75) AND distinctive-token agreement (>= 0.67).
 * Never crosses commits — avoids stale scopes after code moves.
 * File existence is re-validated by the caller before serving.
 */
export async function findRelatedSemanticQueryCache(
    query: string,
    commitSha: string,
    cwd?: string,
    minOverlap = 0.75,
    minDistinctive = 0.67,
): Promise<RelatedSemanticHit | null> {
    const records = await listContextCacheRecords(
        { cacheType: 'semantic', commitSha, limit: 80 },
        cwd,
    );
    let best: RelatedSemanticHit | null = null;
    for (const record of records) {
        try {
            const entry = JSON.parse(record.payloadJson) as SemanticQueryEntry;
            const sourceQuery = entry.query || '';
            const overlap = queryTokenOverlap(query, sourceQuery);
            const distinctive = distinctiveTokenAgreement(query, sourceQuery);
            if (overlap < minOverlap || distinctive < minDistinctive) continue;
            if (normalizeQuery(query) === normalizeQuery(sourceQuery)) continue; // exact path uses getSemanticQueryCache
            if (!best || overlap > best.overlap) {
                best = { entry, overlap, sourceQuery };
            }
        } catch {
            // skip bad payloads
        }
    }
    return best;
}

/**
 * Drop cached scopes that point at files no longer on disk (quality guard).
 */
export async function filterExistingEditScope(
    editScope: string[],
    cwd: string,
): Promise<{ valid: string[]; missing: string[] }> {
    const valid: string[] = [];
    const missing: string[] = [];
    for (const file of editScope) {
        try {
            if (await fs.pathExists(path.join(cwd, file))) valid.push(file);
            else missing.push(file);
        } catch {
            missing.push(file);
        }
    }
    return { valid, missing };
}

/**
 * Layer 4: Task Checkpoint Cache
 */
export async function setTaskCheckpointCache(
    packet: TaskCheckpointPacket,
    rawStateTokens: number,
    cwd?: string
): Promise<void> {
    const cacheKey = `checkpoint:${packet.taskId}:${packet.agentId}:${packet.phase}`;
    const payloadJson = JSON.stringify(packet);
    const checkpointTokens = Math.ceil(payloadJson.length / 4);
    const replayTokensAvoided = Math.max(0, rawStateTokens - checkpointTokens);

    await setContextCacheRecord({
        cacheKey,
        cacheType: 'checkpoint',
        repo: packet.taskId,
        branch: packet.phase,
        commitSha: packet.agentId,
        dependencyFingerprint: `cp-${packet.taskId}`,
        payloadJson,
        payloadTokens: checkpointTokens,
    }, cwd);

    await recordCheckpointMetric({
        checkpointId: cacheKey,
        taskId: packet.taskId,
        agentId: packet.agentId,
        rawStateTokens,
        checkpointTokens,
        replayTokensAvoided,
    }, cwd);
}

export async function getTaskCheckpointCache(
    taskId: string,
    agentId: string,
    phase: string,
    cwd?: string
): Promise<TaskCheckpointPacket | null> {
    const cacheKey = `checkpoint:${taskId}:${agentId}:${phase}`;
    const record = await getContextCacheRecord(cacheKey, cwd);
    if (!record) return null;

    try {
        return JSON.parse(record.payloadJson) as TaskCheckpointPacket;
    } catch {
        return null;
    }
}
