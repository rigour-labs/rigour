/**
 * Memory Persistence Tool Handlers
 *
 * Handlers for: rigour_remember, rigour_forget (rigour_recall is in memory-recall.ts)
 *
 * Three scopes: `repo` (.rigour/memory.json in this checkout), `user`
 * (~/.rigour/memory.json, every repository) and `team` (stored for the repo and
 * shared as a team lesson candidate; teammates' agents receive it once a
 * person promotes it).
 *
 * DLP enforcement: rigour_remember scans BOTH key and value for
 * credentials before persisting. Blocked if secrets detected.
 *
 * @since v2.17.0 — extracted from monolithic index.ts
 * @since v4.2.0  — DLP gate on memory persistence
 */
import { loadMemory, saveMemory, type LocalMemoryScope } from '../utils/config.js';
import {
    scanInputForCredentials,
    formatDLPAlert,
    createDLPAuditEntry,
    loadTeamConfiguration,
    shareMemoryLesson,
} from '@rigour-labs/core';
import {
    loadPatternIndex,
    getDefaultIndexPath,
} from '@rigour-labs/core/pattern-index';
import { buildTelemetryMeta, type GuidanceMeta, type ToolResult } from '../utils/context-telemetry.js';
import { appendContextFooter } from '../utils/context-footer.js';
import fs from 'fs-extra';
import path from 'path';

/**
 * Append a DLP audit event to .rigour/events.jsonl
 */
export async function appendDLPAudit(cwd: string, entry: Record<string, unknown>): Promise<void> {
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

export async function getIndexHealthBlock(cwd: string): Promise<string> {
    const indexPath = getDefaultIndexPath(cwd);
    const index = await loadPatternIndex(indexPath);
    if (!index) {
        return '\n\n📊 Pattern Index: NOT FOUND — call rigour_index to enable scope optimization and reinvention detection.';
    }
    return `\n\n📊 Pattern Index: ${index.stats.totalPatterns} patterns across ${index.stats.totalFiles} files (updated ${index.lastUpdated}).`;
}

export function wrapRecallResult(
    text: string,
    candidateText: string,
    cacheStatus: 'exact-hit' | 'semantic-hit' | 'miss',
    deduplicatedTokens = 0,
    guidance?: GuidanceMeta,
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
        _guidance: guidance,
    };
}

export type MemoryScope = LocalMemoryScope | 'team';

export async function handleRemember(cwd: string, key: string, value: string, scope: MemoryScope = 'repo'): Promise<ToolResult> {
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

    // Clean — proceed with storage. A team memory is kept for this repository too.
    const local: LocalMemoryScope = scope === 'user' ? 'user' : 'repo';
    const store = await loadMemory(cwd, local);
    store.memories[key] = { value, timestamp: new Date().toISOString() };
    await saveMemory(cwd, store, local);
    await appendDLPAudit(cwd, { type: 'memory_stored', key, scope, timestamp: new Date().toISOString() });
    const sharing = scope === 'team' ? await shareWithTeam(cwd, key, value) : '';

    // If there were warnings (non-blocking), include them
    if (dlpResult.status === 'warning') {
        const alert = formatDLPAlert(dlpResult);
        return {
            content: [{
                type: "text",
                text: `MEMORY STORED: "${key}" has been saved (with warnings).${sharing}\n\n${alert}\n\nStored value: ${value}`,
            }],
        };
    }

    return {
        content: [{
            type: "text",
            text: `MEMORY STORED: "${key}" has been saved ${scope === 'user' ? 'for all your repositories' : 'for this repository'}.${sharing}\n\nStored value: ${value}`,
        }],
    };
}

/** Share as a team lesson candidate and say what happens next. */
async function shareWithTeam(cwd: string, key: string, value: string): Promise<string> {
    const lessonId = await shareMemoryLesson(cwd, key, value);
    if (!lessonId) return '\nNot shared: the local knowledge store is unavailable.';
    if (!(await loadTeamConfiguration())) {
        return '\nKept as a team candidate on this machine; it is shared once team mode is configured (rigour team configure).';
    }
    return '\nShared with your team as a candidate. Teammates\' agents receive it once someone promotes it in Studio (Knowledge › Lessons).';
}

export async function handleForget(cwd: string, key: string, scope: LocalMemoryScope = 'repo'): Promise<ToolResult> {
    const store = await loadMemory(cwd, scope);
    if (!store.memories[key]) {
        return { content: [{ type: "text", text: `NO MEMORY FOUND for key "${key}" in ${scope} memory. Nothing to forget.` }] };
    }
    delete store.memories[key];
    await saveMemory(cwd, store, scope);
    return { content: [{ type: "text", text: `MEMORY DELETED: "${key}" has been removed from ${scope} memory.` }] };
}
