/**
 * Handlers for Context Telemetry & Cost Efficiency MCP Tools
 *
 * Handlers for:
 * - rigour_context_stats
 * - rigour_task_cost
 * - rigour_cache_stats
 * - rigour_context_explain
 * - rigour_context_scope
 */

import fs from 'fs-extra';
import path from 'path';
import {
    getTaskContextStats,
    getTaskCostStats,
    getCacheStats,
    explainContext,
    getSemanticQueryCache,
    setSemanticQueryCache,
    estimateTokenCount,
} from '@rigour-labs/core';
import {
    loadPatternIndex,
    getDefaultIndexPath,
    generateEmbedding,
    semanticSearch,
    type PatternEntry,
} from '@rigour-labs/core/pattern-index';
import { buildTelemetryMeta, getWorkspaceCommitSha, type ToolResult } from '../utils/context-telemetry.js';
import { appendContextFooter } from '../utils/context-footer.js';

export async function handleContextStats(cwd: string, taskId?: string): Promise<ToolResult> {
    try {
        const stats = await getTaskContextStats(taskId, cwd);
        const jsonText = JSON.stringify(stats, null, 2);
        return {
            content: [{ type: "text", text: jsonText }],
            _telemetry: buildTelemetryMeta({
                candidateText: jsonText,
                returnedText: jsonText,
                cacheStatus: 'none',
            }),
        };
    } catch (e: any) {
        return {
            content: [{ type: "text", text: `RIGOUR ERROR: ${e.message}` }],
            isError: true,
        };
    }
}

export async function handleTaskCost(cwd: string, taskId?: string): Promise<ToolResult> {
    try {
        const costStats = await getTaskCostStats(taskId, cwd);
        const jsonText = JSON.stringify(costStats, null, 2);
        return {
            content: [{ type: "text", text: jsonText }],
            _telemetry: buildTelemetryMeta({
                candidateText: jsonText,
                returnedText: jsonText,
                cacheStatus: 'none',
            }),
        };
    } catch (e: any) {
        return {
            content: [{ type: "text", text: `RIGOUR ERROR: ${e.message}` }],
            isError: true,
        };
    }
}

export async function handleCacheStats(cwd: string): Promise<ToolResult> {
    try {
        const stats = await getCacheStats(cwd);
        const jsonText = JSON.stringify(stats, null, 2);
        return {
            content: [{ type: "text", text: jsonText }],
            _telemetry: buildTelemetryMeta({
                candidateText: jsonText,
                returnedText: jsonText,
                cacheStatus: 'none',
            }),
        };
    } catch (e: any) {
        return {
            content: [{ type: "text", text: `RIGOUR ERROR: ${e.message}` }],
            isError: true,
        };
    }
}

export async function handleContextExplain(cwd: string, target: string, taskId?: string): Promise<ToolResult> {
    try {
        const explanation = await explainContext(target, taskId, cwd);
        const jsonText = JSON.stringify(explanation, null, 2);
        return {
            content: [{ type: "text", text: jsonText }],
            _telemetry: buildTelemetryMeta({
                candidateText: jsonText,
                returnedText: jsonText,
                cacheStatus: explanation.servedFromCache ? (explanation.cacheStatus as any) : 'miss',
            }),
        };
    } catch (e: any) {
        return {
            content: [{ type: "text", text: `RIGOUR ERROR: ${e.message}` }],
            isError: true,
        };
    }
}

function textMatchPatterns(query: string, patterns: PatternEntry[], limit: number): PatternEntry[] {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const scored = patterns.map(p => {
        const haystack = `${p.name} ${p.type} ${p.description} ${p.file} ${p.keywords?.join(' ') ?? ''}`.toLowerCase();
        const score = terms.reduce((acc, term) => acc + (haystack.includes(term) ? 1 : 0), 0);
        return { pattern: p, score };
    });
    return scored
        .filter(s => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map(s => s.pattern);
}


export async function handleContextScope(
    cwd: string,
    query: string,
    limit = 10,
): Promise<ToolResult> {
    const commitSha = await getWorkspaceCommitSha(cwd);
    const indexPath = getDefaultIndexPath(cwd);
    const fullIndexCandidate = `Full repository scan for: ${query}`;

    const cached = await getSemanticQueryCache(query, commitSha, cwd);
    if (cached) {
        const cachedText = JSON.stringify(cached, null, 2);
        const telemetry = buildTelemetryMeta({
            candidateText: fullIndexCandidate,
            returnedText: cachedText,
            cacheStatus: 'semantic-hit',
        });
        const text = `CONTEXT SCOPE (cached)\n\n${cachedText}`;
        return {
            content: [{ type: 'text', text: appendContextFooter(text, telemetry, 'rigour_check_pattern before creating code') }],
            _telemetry: telemetry,
        };
    }

    const index = await loadPatternIndex(indexPath);
    if (!index) {
        const text = '⚠️ Pattern index not found. Call rigour_index first to enable scoped context retrieval.\n\n'
            + 'Without an index, agents tend to read entire directories — wasting tokens.';
        return {
            content: [{ type: 'text', text }],
            _telemetry: buildTelemetryMeta({
                candidateText: fullIndexCandidate,
                returnedText: text,
                cacheStatus: 'miss',
            }),
        };
    }

    let matched: PatternEntry[] = [];
    const hasEmbeddings = index.patterns.some(p => p.embedding && p.embedding.length > 0);

    if (hasEmbeddings) {
        try {
            const queryVector = await generateEmbedding(query);
            const similarities = semanticSearch(queryVector, index.patterns);
            matched = index.patterns
                .map((p, i) => ({ pattern: p, similarity: similarities[i] ?? 0 }))
                .filter(r => r.similarity > 0.3)
                .sort((a, b) => b.similarity - a.similarity)
                .slice(0, limit)
                .map(r => r.pattern);
        } catch {
            matched = textMatchPatterns(query, index.patterns, limit);
        }
    } else {
        matched = textMatchPatterns(query, index.patterns, limit);
    }

    const editScope = Array.from(new Set(matched.map(p => p.file)));
    const allFiles = Array.from(new Set(index.patterns.map(p => p.file)));
    const skipScope = allFiles
        .filter(f => !editScope.includes(f))
        .slice(0, Math.max(0, 20 - editScope.length))
        .map(f => ({ file: f, reason: 'Outside semantic match for query' }));

    const signatures = matched.map(p =>
        `- ${p.file}:${p.line} ${p.type} ${p.name} — ${p.signature || p.description || '(no signature)'}`
    );

    let fullFileTokens = 0;
    for (const file of editScope) {
        try {
            const content = await fs.readFile(path.join(cwd, file), 'utf-8');
            fullFileTokens += estimateTokenCount(content);
        } catch {
            fullFileTokens += 500;
        }
    }

    const scopePayload = {
        query,
        editScope,
        skipScope,
        signatures,
        indexHealth: {
            totalPatterns: index.stats.totalPatterns,
            totalFiles: index.stats.totalFiles,
            lastUpdated: index.lastUpdated,
            semanticEnabled: hasEmbeddings,
        },
        estimatedTokensSaved: Math.max(0, fullFileTokens - estimateTokenCount(signatures.join('\n'))),
        recommendation: editScope.length > 0
            ? `Read ONLY these ${editScope.length} file(s). Do NOT scan the whole repo.`
            : 'No strong matches — refine query or run rigour_index --semantic',
    };

    await setSemanticQueryCache(query, commitSha, {
        query,
        resolvedOwner: editScope[0] ? path.dirname(editScope[0]) : 'unknown',
        editScope,
        validationScope: editScope.map(f => `review ${f}`),
        evidence: signatures.slice(0, 5),
        commitSha,
        confidence: matched.length > 0 ? 0.85 : 0.3,
    }, cwd);

    const resultText = JSON.stringify(scopePayload, null, 2);
    const telemetry = buildTelemetryMeta({
        candidateText: fullIndexCandidate,
        returnedText: resultText,
        cacheStatus: 'miss',
        deduplicatedTokens: scopePayload.estimatedTokensSaved,
    });

    return {
        content: [{
            type: 'text',
            text: appendContextFooter(`CONTEXT SCOPE\n\n${resultText}`, telemetry, 'rigour_check_pattern before creating code'),
        }],
        _telemetry: telemetry,
    };
}
