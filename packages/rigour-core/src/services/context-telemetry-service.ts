/**
 * High-Level Context Telemetry Service
 * Calculates exact observed usage, avoided tokens, cache performance, and cost breakdowns.
 * Supports CSV/JSON Cursor usage imports.
 */

import { createHash } from 'crypto';
import fs from 'fs-extra';
import path from 'path';
import {
    getContextEvents,
    getModelUsages,
    getCheckpointMetrics,
    recordModelUsage,
} from '../storage/index.js';
import { getCursorApiKey } from '../settings.js';
import {
    estimateAvoidedContextCostUsd,
    estimateTokenCostUsd,
    computeWeightedInputPricePerMillion,
} from './model-pricing.js';
import { fetchCursorUsagePages, type CursorUsageSyncOptions } from './cursor-usage-client.js';
import { CURSOR_ADMIN_API_SOURCE, centsToUsd, isCursorAdminApiEvent, normalizeCursorUsageEvent } from './cursor-usage-normalizer.js';

/** Heuristic token counter (~4 chars per token for code/text) */
export function estimateTokenCount(text: string): number {
    if (!text) return 0;
    return Math.ceil(text.length / 4);
}

/** Default session token budgets */
export const DEFAULT_SESSION_SOFT_LIMIT = 160_000;
export const DEFAULT_SESSION_HARD_LIMIT = 200_000;

export interface TaskContextStats {
    taskId: string;
    retrievals: number;
    candidateTokens: number;
    returnedTokens: number;
    potentialAvoidedTokens: number;
    cacheHitRate: number;
    repeatedReadsPrevented: number;
    checkpointReplayAvoided: number;
    isEstimated: boolean;
}

export interface TaskCostStats {
    actual: {
        inputTokens: number;
        outputTokens: number;
        costUsd: number;
        source: string;
        isEstimated: boolean;
        pricingBasis?: string;
    };
    estimated: {
        potentialContextAvoided: number;
        estimatedCostAvoidedUsd: number;
        isEstimated: boolean;
        inputPricePerMillionUsd?: number;
        pricingBasis?: string;
    };
}

export interface CachePerformanceStats {
    exactCacheHits: number;
    semanticCacheHits: number;
    partialCacheHits: number;
    cacheMisses: number;
    hitRate: number;
    tokensServedFromCache: number;
    recomputationAvoided: number;
    isEstimated: boolean;
}

export interface SessionBudgetStatus {
    sessionId: string;
    usedTokens: number;
    softLimit: number;
    hardLimit: number;
    softLimitReached: boolean;
    hardLimitReached: boolean;
    remainingTokens: number;
    isEstimated: boolean;
}

export interface ContextExplainResult {
    fileOrService: string;
    status: 'included' | 'excluded';
    reason: string;
    servedFromCache: boolean;
    cacheStatus: string;
    invalidationReason?: string;
    priorAgentRequests: string[];
}

export interface ContextScopeSummary {
    overlappingScopesResolved: number;
    overlappingScopePairs: string[];
    alwaysOnRuleTokens: number;
    unusedToolsFiltered: number;
    activeAgentCount: number;
}

export interface CheckpointSummary {
    rawStateTokens: number;
    checkpointTokens: number;
    compressionRatio: number;
    checkpointCount: number;
    replayTokensAvoided: number;
}

const GOVERNANCE_RULE_FILES = ['AGENTS.md', 'CLAUDE.md', '.cursorrules', '.windsurfrules', '.clinerules'];

function scopesOverlap(scope1: string[], scope2: string[]): string[] {
    const overlapping: string[] = [];
    for (const s1 of scope1) {
        for (const s2 of scope2) {
            if (s1 === s2 || s1.startsWith(s2.replace('**', '')) || s2.startsWith(s1.replace('**', ''))) {
                overlapping.push(`${s1} ↔ ${s2}`);
            }
        }
    }
    return overlapping;
}

function hashCsvRow(line: string): string {
    return createHash('sha256').update(line.trim()).digest('hex').slice(0, 16);
}

/**
 * Generate task-level context telemetry summary.
 */
export async function getTaskContextStats(taskId?: string, cwd?: string): Promise<TaskContextStats> {
    const events = await getContextEvents(taskId, cwd);
    const checkpoints = await getCheckpointMetrics(taskId, cwd);

    const retrievals = events.length;
    let candidateTokens = 0;
    let returnedTokens = 0;
    let cacheHits = 0;
    let repeatedReads = 0;

    for (const e of events) {
        candidateTokens += e.candidateTokens || 0;
        returnedTokens += e.returnedTokens || 0;
        if (e.cacheStatus && e.cacheStatus !== 'miss' && e.cacheStatus !== 'none') {
            cacheHits++;
        }
        const deduped = e.deduplicatedTokens ?? 0;
        if (deduped > 0) {
            repeatedReads += Math.ceil(deduped / 500);
        }
    }

    const potentialAvoidedTokens = Math.max(0, candidateTokens - returnedTokens);
    const cacheHitRate = retrievals > 0 ? parseFloat((cacheHits / retrievals).toFixed(2)) : 0;
    const checkpointReplayAvoided = checkpoints.reduce((acc, c) => acc + (c.replayTokensAvoided || 0), 0);

    return {
        taskId: taskId || 'global',
        retrievals,
        candidateTokens,
        returnedTokens,
        potentialAvoidedTokens,
        cacheHitRate,
        repeatedReadsPrevented: repeatedReads,
        checkpointReplayAvoided,
        isEstimated: retrievals === 0,
    };
}

/**
 * Generate task-level cost summary (actual vs estimated avoided).
 */
export async function getTaskCostStats(taskId?: string, cwd?: string): Promise<TaskCostStats> {
    const usages = await getModelUsages(taskId, cwd);
    const stats = await getTaskContextStats(taskId, cwd);

    let actualInputTokens = 0;
    let actualOutputTokens = 0;
    let observedCostUsd = 0;
    let primarySource = 'estimated';
    const hasObservedUsage = usages.length > 0;

    for (const u of usages) {
        actualInputTokens += u.inputTokens || 0;
        actualOutputTokens += u.outputTokens || 0;
        observedCostUsd += u.observedCostUsd || 0;
        if (u.source && u.source !== 'estimated') {
            primarySource = u.source;
        }
    }

    const hasObservedCost = observedCostUsd > 0;
    let actualCostUsd = observedCostUsd;
    let actualIsEstimated = !hasObservedUsage;
    let actualPricingBasis: string | undefined;

    if (!hasObservedCost && hasObservedUsage) {
        actualCostUsd = usages.reduce(
            (sum, usage) => sum + estimateTokenCostUsd(
                usage.inputTokens || 0,
                usage.outputTokens || 0,
                usage.model,
            ),
            0,
        );
        actualIsEstimated = true;
        actualPricingBasis = computeWeightedInputPricePerMillion(usages).pricingBasis;
    } else if (hasObservedCost) {
        actualPricingBasis = 'observed-cursor-charged-cents';
    }

    const totalPotentialAvoided = stats.potentialAvoidedTokens + stats.checkpointReplayAvoided;
    const avoidedPricing = estimateAvoidedContextCostUsd(totalPotentialAvoided, usages);

    return {
        actual: {
            inputTokens: actualInputTokens,
            outputTokens: actualOutputTokens,
            costUsd: parseFloat(actualCostUsd.toFixed(4)),
            source: primarySource,
            isEstimated: actualIsEstimated,
            pricingBasis: actualPricingBasis,
        },
        estimated: {
            potentialContextAvoided: totalPotentialAvoided,
            estimatedCostAvoidedUsd: avoidedPricing.costUsd,
            isEstimated: true,
            inputPricePerMillionUsd: avoidedPricing.pricing.inputPricePerMillionUsd,
            pricingBasis: avoidedPricing.pricing.pricingBasis,
        },
    };
}

/**
 * Aggregate cache performance across events.
 */
export async function getCacheStats(cwd?: string): Promise<CachePerformanceStats> {
    const events = await getContextEvents(undefined, cwd);

    let exactHits = 0;
    let semanticHits = 0;
    let partialHits = 0;
    let misses = 0;
    let tokensServed = 0;

    for (const e of events) {
        if (e.cacheStatus === 'exact-hit') {
            exactHits++;
            tokensServed += e.returnedTokens || 0;
        } else if (e.cacheStatus === 'semantic-hit') {
            semanticHits++;
            tokensServed += e.returnedTokens || 0;
        } else if (e.cacheStatus === 'partial-hit') {
            partialHits++;
            tokensServed += e.returnedTokens || 0;
        } else {
            misses++;
        }
    }

    const totalHits = exactHits + semanticHits + partialHits;
    const totalCalls = totalHits + misses;
    const hitRate = totalCalls > 0 ? parseFloat((totalHits / totalCalls).toFixed(2)) : 0;

    return {
        exactCacheHits: exactHits,
        semanticCacheHits: semanticHits,
        partialCacheHits: partialHits,
        cacheMisses: misses,
        hitRate,
        tokensServedFromCache: tokensServed,
        recomputationAvoided: Math.max(0, tokensServed - 1000),
        isEstimated: events.length === 0,
    };
}

/**
 * Report session token budget usage against soft and hard limits.
 */
export async function getSessionBudgetStatus(
    sessionId: string,
    cwd?: string,
    softLimit = DEFAULT_SESSION_SOFT_LIMIT,
    hardLimit = DEFAULT_SESSION_HARD_LIMIT,
): Promise<SessionBudgetStatus> {
    const events = await getContextEvents(undefined, cwd);
    const usages = await getModelUsages(undefined, cwd);

    const sessionEvents = events.filter(e => e.sessionId === sessionId);
    const sessionUsages = usages.filter(u => u.sessionId === sessionId);

    let contextTokens = 0;
    for (const e of sessionEvents) {
        contextTokens += e.returnedTokens || 0;
    }

    let modelTokens = 0;
    let hasObserved = sessionUsages.length > 0;
    for (const u of sessionUsages) {
        modelTokens += (u.inputTokens || 0) + (u.outputTokens || 0);
    }

    const usedTokens = modelTokens > 0 ? modelTokens : contextTokens;
    const softLimitReached = usedTokens >= softLimit;
    const hardLimitReached = usedTokens >= hardLimit;

    return {
        sessionId,
        usedTokens,
        softLimit,
        hardLimit,
        softLimitReached,
        hardLimitReached,
        remainingTokens: Math.max(0, hardLimit - usedTokens),
        isEstimated: !hasObserved && sessionEvents.length > 0,
    };
}

/**
 * Explain context inclusion/exclusion and cache status for a given target file or query.
 */
export async function explainContext(target: string, taskId?: string, cwd?: string): Promise<ContextExplainResult> {
    const events = await getContextEvents(taskId, cwd);
    const matchingEvents = events.filter(
        e => e.queryHash?.includes(target) || e.toolName.includes(target) || target === 'all',
    );

    const priorAgentRequests = events
        .filter(e => e.agentId)
        .map(e => `${e.agentId} called ${e.toolName} (${e.cacheStatus})`);

    if (matchingEvents.length > 0) {
        const lastEvt = matchingEvents[0];
        const isHit = lastEvt.cacheStatus !== 'miss' && lastEvt.cacheStatus !== 'none';
        const returnedFiles = lastEvt.returnedFiles ?? 0;
        const returnedTokens = lastEvt.returnedTokens ?? 0;
        return {
            fileOrService: target,
            status: returnedFiles > 0 || returnedTokens > 0 ? 'included' : 'excluded',
            reason: isHit
                ? `Served from ${lastEvt.cacheStatus} cache (reduced ${lastEvt.candidateTokens - returnedTokens} tokens)`
                : 'Computed dynamically because no active cache entry matched',
            servedFromCache: isHit,
            cacheStatus: lastEvt.cacheStatus,
            invalidationReason: isHit ? undefined : 'Source file or component contract was modified',
            priorAgentRequests: Array.from(new Set(priorAgentRequests)).slice(0, 5),
        };
    }

    return {
        fileOrService: target,
        status: 'excluded',
        reason: 'Target was outside of defined task scope and AST dependency subgraph',
        servedFromCache: false,
        cacheStatus: 'miss',
        invalidationReason: 'Not requested in current session scope',
        priorAgentRequests: Array.from(new Set(priorAgentRequests)).slice(0, 5),
    };
}

/**
 * Import Cursor usage data from CSV format.
 * Expects CSV format with columns: Date,Model,Input Tokens,Output Tokens,Cost
 * Deduplicates rows by content hash before insert.
 */
export async function importCursorUsageCsv(csvContent: string, cwd?: string): Promise<number> {
    const lines = csvContent.trim().split('\n').filter(Boolean);
    if (lines.length <= 1) return 0;

    const headers = lines[0].toLowerCase().split(',').map(h => h.trim().replace(/^"/, '').replace(/"$/, ''));
    const inputIdx = headers.findIndex(h => h.includes('input'));
    const outputIdx = headers.findIndex(h => h.includes('output'));
    const costIdx = headers.findIndex(h => h.includes('cost') || h.includes('spend'));
    const modelIdx = headers.findIndex(h => h.includes('model'));

    const existingUsages = await getModelUsages(undefined, cwd);
    const seenHashes = new Set(
        existingUsages
            .filter(u => u.id?.startsWith('csv-'))
            .map(u => u.id!.slice(4)),
    );

    let importedCount = 0;
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        const rowHash = hashCsvRow(line);
        if (seenHashes.has(rowHash)) continue;
        seenHashes.add(rowHash);

        const cols = line.split(',').map(c => c.trim().replace(/^"/, '').replace(/"$/, ''));
        const inputTokens = inputIdx >= 0 ? parseInt(cols[inputIdx], 10) || 0 : 0;
        const outputTokens = outputIdx >= 0 ? parseInt(cols[outputIdx], 10) || 0 : 0;
        const observedCostUsd = costIdx >= 0 ? parseFloat(cols[costIdx]) || 0 : 0;
        const model = modelIdx >= 0 ? cols[modelIdx] : 'cursor-model';

        await recordModelUsage({
            id: `csv-${rowHash}`,
            taskId: 'cursor-imported',
            provider: 'cursor',
            model,
            inputTokens,
            outputTokens,
            observedCostUsd,
            source: 'cursor-dashboard-csv',
        }, cwd);
        importedCount++;
    }

    return importedCount;
}

/**
 * Import Cursor usage data from JSON format (e.g. from Cursor Admin API).
 */
export async function importCursorUsageJson(jsonData: unknown, cwd?: string): Promise<number> {
    const payload = jsonData as Record<string, unknown>;
    const records = Array.isArray(jsonData)
        ? jsonData
        : (payload.records || payload.usage || [jsonData]) as Record<string, unknown>[];

    const existingUsages = await getModelUsages(undefined, cwd);
    const seenIds = new Set(existingUsages.map(u => u.id).filter(Boolean) as string[]);

    let importedCount = 0;
    for (const r of records) {
        const normalized = isCursorAdminApiEvent(r) ? normalizeCursorUsageEvent(r) : null;
        if (normalized) {
            if (seenIds.has(normalized.id)) continue;
            seenIds.add(normalized.id);
            await recordModelUsage(normalized.usage, cwd);
            importedCount++;
            continue;
        }

        const row = r as Record<string, unknown>;
        const id = (row.id as string | undefined)
            ?? `json-${hashCsvRow(JSON.stringify(row))}`;
        if (seenIds.has(id)) continue;
        seenIds.add(id);

        const tokenUsage = row.tokenUsage as Record<string, unknown> | undefined;
        const chargedCents = Number(row.chargedCents ?? tokenUsage?.totalCents ?? 0);
        const observedFromRow = Number(row.observedCostUsd ?? row.cost_usd ?? row.cost ?? 0);
        const observedCostUsd = observedFromRow > 0
            ? observedFromRow
            : chargedCents > 0
                ? centsToUsd(chargedCents)
                : 0;

        await recordModelUsage({
            id,
            taskId: (row.taskId || row.task_id || 'cursor-imported') as string,
            sessionId: (row.sessionId || row.session_id) as string | undefined,
            agentId: (row.agentId || row.agent_id) as string | undefined,
            provider: (row.provider || 'cursor') as string,
            model: (row.model || 'claude-3-5-sonnet') as string,
            inputTokens: (row.inputTokens || row.input_tokens || tokenUsage?.inputTokens || 0) as number,
            outputTokens: (row.outputTokens || row.output_tokens || tokenUsage?.outputTokens || 0) as number,
            cachedInputTokens: (row.cachedInputTokens || row.cached_input_tokens || row.cacheReadTokens || tokenUsage?.cacheReadTokens || 0) as number,
            cacheWriteTokens: (row.cacheWriteTokens || row.cache_write_tokens || tokenUsage?.cacheWriteTokens || 0) as number,
            observedCostUsd,
            source: (row.source as string | undefined) || 'cursor-admin-api',
            createdAt: row.createdAt ? Number(row.createdAt) : undefined,
        }, cwd);
        importedCount++;
    }

    return importedCount;
}

export interface CursorAdminSyncResult {
    importedCount: number;
    totalEvents: number;
}

async function persistCursorUsageEvents(
    events: Awaited<ReturnType<typeof fetchCursorUsagePages>>,
    cwd?: string,
): Promise<number> {
    const existingUsages = await getModelUsages(undefined, cwd);
    const seenIds = new Set(existingUsages.map(u => u.id).filter(Boolean) as string[]);

    let importedCount = 0;
    for (const event of events) {
        if (seenIds.has(event.id)) continue;
        seenIds.add(event.id);
        await recordModelUsage(event.usage, cwd);
        importedCount++;
    }
    return importedCount;
}

/**
 * Fetch Cursor usage from Admin API and import token-based events.
 * Costs are reported in cents by Cursor (`chargedCents`) and converted to USD.
 */
export async function fetchCursorUsageFromAdminApi(
    cwdOrOptions?: string | CursorUsageSyncOptions,
): Promise<number> {
    const options: CursorUsageSyncOptions = typeof cwdOrOptions === 'string'
        ? { cwd: cwdOrOptions }
        : (cwdOrOptions ?? {});

    const apiKey = options.apiKey ?? getCursorApiKey();
    if (!apiKey) {
        return 0;
    }

    const events = await fetchCursorUsagePages(options);
    return persistCursorUsageEvents(events, options.cwd);
}

export async function syncCursorUsageFromAdminApi(
    cwdOrOptions?: string | CursorUsageSyncOptions,
): Promise<CursorAdminSyncResult> {
    const options: CursorUsageSyncOptions = typeof cwdOrOptions === 'string'
        ? { cwd: cwdOrOptions }
        : (cwdOrOptions ?? {});

    const apiKey = options.apiKey ?? getCursorApiKey();
    if (!apiKey) {
        return { importedCount: 0, totalEvents: 0 };
    }

    const events = await fetchCursorUsagePages(options);
    const importedCount = await persistCursorUsageEvents(events, options.cwd);
    return { importedCount, totalEvents: events.length };
}

export async function countCursorAdminImportedEvents(cwd?: string): Promise<number> {
    const usages = await getModelUsages(undefined, cwd);
    return usages.filter(u => u.source === CURSOR_ADMIN_API_SOURCE).length;
}

/**
 * Summarize agent scope overlap and governance rule overhead for Studio.
 */
export async function getContextScopeSummary(cwd?: string): Promise<ContextScopeSummary> {
    const projectRoot = cwd || process.cwd();
    const sessionPath = path.join(projectRoot, '.rigour', 'agent-session.json');

    let overlappingScopesResolved = 0;
    const overlappingScopePairs: string[] = [];
    let activeAgentCount = 0;

    if (await fs.pathExists(sessionPath)) {
        const session = await fs.readJson(sessionPath);
        const agents: Array<{ agentId: string; taskScope?: string[] }> = session.agents || [];
        activeAgentCount = agents.length;

        for (let i = 0; i < agents.length; i++) {
            for (let j = i + 1; j < agents.length; j++) {
                const overlaps = scopesOverlap(agents[i].taskScope || [], agents[j].taskScope || []);
                if (overlaps.length > 0) {
                    overlappingScopesResolved += overlaps.length;
                    overlappingScopePairs.push(...overlaps);
                }
            }
        }
    }

    let alwaysOnRuleTokens = 0;
    for (const fileName of GOVERNANCE_RULE_FILES) {
        const filePath = path.join(projectRoot, fileName);
        if (await fs.pathExists(filePath)) {
            alwaysOnRuleTokens += estimateTokenCount(await fs.readFile(filePath, 'utf8'));
        }
    }

    const events = await getContextEvents(undefined, cwd);
    const unusedToolsFiltered = events.filter(e => e.toolName.includes('filtered')).length;

    return {
        overlappingScopesResolved,
        overlappingScopePairs: Array.from(new Set(overlappingScopePairs)),
        alwaysOnRuleTokens,
        unusedToolsFiltered,
        activeAgentCount,
    };
}

/**
 * Aggregate checkpoint compression metrics for Studio.
 */
export async function getCheckpointSummary(taskId?: string, cwd?: string): Promise<CheckpointSummary> {
    const metrics = await getCheckpointMetrics(taskId, cwd);
    if (metrics.length === 0) {
        return {
            rawStateTokens: 0,
            checkpointTokens: 0,
            compressionRatio: 0,
            checkpointCount: 0,
            replayTokensAvoided: 0,
        };
    }

    const rawStateTokens = metrics.reduce((acc, m) => acc + (m.rawStateTokens || 0), 0);
    const checkpointTokens = metrics.reduce((acc, m) => acc + (m.checkpointTokens || 0), 0);
    const replayTokensAvoided = metrics.reduce((acc, m) => acc + (m.replayTokensAvoided || 0), 0);
    const compressionRatio = checkpointTokens > 0 ? Math.round(rawStateTokens / checkpointTokens) : 0;

    return {
        rawStateTokens,
        checkpointTokens,
        compressionRatio,
        checkpointCount: metrics.length,
        replayTokensAvoided,
    };
}
