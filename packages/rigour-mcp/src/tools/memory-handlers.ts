/**
 * Memory Persistence Tool Handlers
 *
 * Handlers for: rigour_remember, rigour_recall, rigour_forget
 *
 * DLP enforcement: rigour_remember scans BOTH key and value for
 * credentials before persisting. Blocked if secrets detected.
 *
 * @since v2.17.0 — extracted from monolithic index.ts
 * @since v4.2.0  — DLP gate on memory persistence
 */
import { loadMemory, saveMemory } from '../utils/config.js';
import {
    scanInputForCredentials,
    formatDLPAlert,
    createDLPAuditEntry,
    getSemanticQueryCache,
    setSemanticQueryCache,
    estimateTokenCount,
} from '@rigour-labs/core';
import {
    loadPatternIndex,
    getDefaultIndexPath,
} from '@rigour-labs/core/pattern-index';
import { buildTelemetryMeta, getWorkspaceCommitSha, type ToolResult } from '../utils/context-telemetry.js';
import { appendContextFooter } from '../utils/context-footer.js';
import fs from 'fs-extra';
import path from 'path';

/**
 * Append a DLP audit event to .rigour/events.jsonl
 */
async function appendDLPAudit(cwd: string, entry: Record<string, unknown>): Promise<void> {
    try {
        const eventsPath = path.join(cwd, '.rigour', 'events.jsonl');
        await fs.ensureDir(path.dirname(eventsPath));
        await fs.appendFile(eventsPath, JSON.stringify(entry) + '\n');
    } catch {
        // Audit logging is best-effort, never block on failure
    }
}

/**
 * Deep-scan a value: if JSON, extract all nested string values and scan each.
 * Catches agents serializing credentials as JSON to bypass flat-text scanning.
 */
function deepScanValue(key: string, value: string): string {
    const texts = [key, value];
    try {
        const parsed = JSON.parse(value);
        extractStrings(parsed, texts);
    } catch { /* not JSON — flat scan is sufficient */ }
    return texts.join('\n');
}

function extractStrings(obj: unknown, out: string[]): void {
    if (typeof obj === 'string' && obj.length >= 8) out.push(obj);
    else if (Array.isArray(obj)) obj.forEach(v => extractStrings(v, out));
    else if (obj && typeof obj === 'object') {
        for (const v of Object.values(obj)) extractStrings(v, out);
    }
}

async function getIndexHealthBlock(cwd: string): Promise<string> {
    const indexPath = getDefaultIndexPath(cwd);
    const index = await loadPatternIndex(indexPath);
    if (!index) {
        return '\n\n📊 Pattern Index: NOT FOUND — call rigour_index to enable scope optimization and reinvention detection.';
    }
    return `\n\n📊 Pattern Index: ${index.stats.totalPatterns} patterns across ${index.stats.totalFiles} files (updated ${index.lastUpdated}).`;
}

function wrapRecallResult(
    text: string,
    candidateText: string,
    cacheStatus: 'exact-hit' | 'semantic-hit' | 'miss',
    deduplicatedTokens = 0,
): ToolResult {
    const telemetry = buildTelemetryMeta({
        candidateText,
        returnedText: text,
        cacheStatus,
        deduplicatedTokens,
    });
    return {
        content: [{
            type: 'text',
            text: appendContextFooter(text, telemetry, 'rigour_context_scope("your task")'),
        }],
        _telemetry: telemetry,
    };
}

export async function handleRemember(cwd: string, key: string, value: string): Promise<ToolResult> {
    // Fallback: if key is missing but value exists, auto-generate a key
    if (!key && value) {
        key = value.slice(0, 40).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'convention';
    }
    // If value is missing but key exists, something is wrong
    if (!value) {
        return {
            content: [{
                type: "text",
                text: `ERROR: Missing 'value' parameter. Call rigour_remember with both 'key' (short identifier) and 'value' (the instruction text to persist).`,
            }],
        };
    }

    // ── DLP Gate: deep-scan key + value (including JSON interiors) ──
    const textToScan = deepScanValue(key, value);
    const dlpResult = scanInputForCredentials(textToScan);

    if (dlpResult.status === 'blocked') {
        // Log the blocked attempt
        const auditEntry = createDLPAuditEntry(dlpResult, {
            agent: 'rigour_remember',
            userId: key,
        });
        await appendDLPAudit(cwd, { ...auditEntry, memory_key: key });

        const alert = formatDLPAlert(dlpResult);
        return {
            content: [{
                type: "text",
                text: `🛑 MEMORY BLOCKED — credentials detected in value for key "${key}".\n\n${alert}\n\nRigour prevented storing secrets in persistent memory. Use environment variables instead.`,
            }],
        };
    }

    // Clean — proceed with storage
    const store = await loadMemory(cwd);
    store.memories[key] = { value, timestamp: new Date().toISOString() };
    await saveMemory(cwd, store);

    // If there were warnings (non-blocking), include them
    if (dlpResult.status === 'warning') {
        const alert = formatDLPAlert(dlpResult);
        return {
            content: [{
                type: "text",
                text: `MEMORY STORED: "${key}" has been saved (with warnings).\n\n${alert}\n\nStored value: ${value}`,
            }],
        };
    }

    return {
        content: [{
            type: "text",
            text: `MEMORY STORED: "${key}" has been saved. This instruction will persist across sessions.\n\nStored value: ${value}`,
        }],
    };
}

export async function handleRecall(cwd: string, key?: string): Promise<ToolResult> {
    const commitSha = await getWorkspaceCommitSha(cwd);
    const cacheQuery = key ? `recall:${key}` : 'recall:all';
    const store = await loadMemory(cwd);
    const candidateText = JSON.stringify(store);

    const cached = await getSemanticQueryCache(cacheQuery, commitSha, cwd);
    if (cached?.evidence?.length) {
        const cachedBody = cached.evidence.join('\n');
        const indexHealth = await getIndexHealthBlock(cwd);
        return wrapRecallResult(
            `${cachedBody}${indexHealth}`,
            candidateText,
            'semantic-hit',
            Math.max(0, estimateTokenCount(candidateText) - estimateTokenCount(cachedBody)),
        );
    }

    if (key) {
        const memory = store.memories[key];
        if (!memory) {
            const text = `NO MEMORY FOUND for key "${key}". Use rigour_remember to store instructions.${await getIndexHealthBlock(cwd)}`;
            return wrapRecallResult(text, candidateText, 'miss');
        }

        // ── DLP Gate on recall: catch credentials stored before DLP existed ──
        const dlpResult = scanInputForCredentials(memory.value);
        if (dlpResult.status === 'blocked') {
            const alert = formatDLPAlert(dlpResult);
            await appendDLPAudit(cwd, {
                ...createDLPAuditEntry(dlpResult, { agent: 'rigour_recall' }),
                memory_key: key,
                action: 'recall_blocked',
            });
            return {
                content: [{
                    type: "text",
                    text: `🛑 RECALL BLOCKED — memory "${key}" contains ${dlpResult.detections.length} credential(s).\n\n${alert}\n\nThis memory was stored before DLP was active. Remove it with rigour_forget("${key}") and use environment variables instead.`,
                }],
            };
        }

        const body = `RECALLED MEMORY [${key}]:\n${memory.value}\n\n(Stored: ${memory.timestamp})`;
        const indexHealth = await getIndexHealthBlock(cwd);
        const fullText = `${body}${indexHealth}`;

        await setSemanticQueryCache(cacheQuery, commitSha, {
            query: cacheQuery,
            resolvedOwner: 'memory',
            editScope: [],
            validationScope: [],
            evidence: [body],
            commitSha,
            confidence: 1,
        }, cwd);

        return wrapRecallResult(fullText, candidateText, 'miss');
    }

    const keys = Object.keys(store.memories);
    if (keys.length === 0) {
        const text = `NO MEMORIES STORED. Use rigour_remember to persist important instructions.${await getIndexHealthBlock(cwd)}`;
        return wrapRecallResult(text, candidateText, 'miss');
    }

    // ── DLP scan all memories on bulk recall ──
    const cleanMemories: string[] = [];
    const taintedKeys: string[] = [];

    for (const k of keys) {
        const mem = store.memories[k];
        const dlpResult = scanInputForCredentials(mem.value);
        if (dlpResult.status === 'blocked') {
            taintedKeys.push(k);
        } else {
            cleanMemories.push(`## ${k}\n${mem.value}\n(Stored: ${mem.timestamp})`);
        }
    }

    let text = '';
    if (taintedKeys.length > 0) {
        text += `🛑 ${taintedKeys.length} memory(ies) BLOCKED — contain credentials: ${taintedKeys.join(', ')}\nUse rigour_forget to remove them.\n\n---\n\n`;
    }
    if (cleanMemories.length > 0) {
        text += `RECALLED ${cleanMemories.length} CLEAN MEMORIES:\n\n${cleanMemories.join('\n\n---\n\n')}\n\n---\nIMPORTANT: Follow these stored instructions throughout this session.`;
    } else if (taintedKeys.length > 0) {
        text += `No clean memories to recall. All stored memories contain credentials.`;
    } else {
        text = "NO MEMORIES STORED. Use rigour_remember to persist important instructions.";
    }

    text += await getIndexHealthBlock(cwd);

    await setSemanticQueryCache(cacheQuery, commitSha, {
        query: cacheQuery,
        resolvedOwner: 'memory',
        editScope: [],
        validationScope: [],
        evidence: [text],
        commitSha,
        confidence: 1,
    }, cwd);

    return wrapRecallResult(
        text,
        candidateText,
        'miss',
        Math.max(0, estimateTokenCount(candidateText) - estimateTokenCount(text)),
    );
}

export async function handleForget(cwd: string, key: string): Promise<ToolResult> {
    const store = await loadMemory(cwd);
    if (!store.memories[key]) {
        return { content: [{ type: "text", text: `NO MEMORY FOUND for key "${key}". Nothing to forget.` }] };
    }
    delete store.memories[key];
    await saveMemory(cwd, store);
    return { content: [{ type: "text", text: `MEMORY DELETED: "${key}" has been removed.` }] };
}
