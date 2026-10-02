/**
 * rigour_recall: memories back to the agent.
 *
 * - `key`: that memory, from this repository, else from the user's own memory.
 * - `query`: the few memories that match by meaning (local, see core
 *   memory/recall.ts), plus team knowledge from pgvector when team mode is on:
 *   lessons a person promoted, never a teammate's unreviewed candidate.
 * - neither: every repository and user memory, as an agent loads at the start.
 *
 * Every returned memory passes the credential scan first; nothing is cached.
 */
import { formatDLPAlert, createDLPAuditEntry, rankMemories, scanInputForCredentials, searchTeamKnowledge, type MemoryEntry } from '@rigour-labs/core';
import { loadMemory } from '../utils/config.js';
import type { GuidanceMeta, ToolResult } from '../utils/context-telemetry.js';
import { appendDLPAudit, getIndexHealthBlock, wrapRecallResult } from './memory-handlers.js';

export interface RecallArgs {
    key?: string;
    query?: string;
}

export async function handleRecall(cwd: string, args: RecallArgs = {}): Promise<ToolResult> {
    const entries = await localEntries(cwd);
    const candidateText = JSON.stringify(entries);
    if (args.key) return recallKey(cwd, args.key, entries, candidateText);
    if (args.query?.trim()) return recallQuery(cwd, args.query.trim(), entries, candidateText);
    return recallAll(cwd, entries, candidateText);
}

/** Repository memories first, then the user's own; a repository memory wins a shared key. */
async function localEntries(cwd: string): Promise<MemoryEntry[]> {
    const repo = await loadMemory(cwd, 'repo');
    const user = await loadMemory(cwd, 'user');
    const toEntries = (scope: MemoryEntry['scope'], store: typeof repo) =>
        Object.entries(store.memories).map(([key, m]) => ({ scope, key, value: m.value, timestamp: m.timestamp }));
    const repoEntries = toEntries('repo', repo);
    const repoKeys = new Set(repoEntries.map(e => e.key));
    return [...repoEntries, ...toEntries('user', user).filter(e => !repoKeys.has(e.key))];
}

async function recallKey(cwd: string, key: string, entries: MemoryEntry[], candidateText: string): Promise<ToolResult> {
    const memory = entries.find(e => e.key === key);
    if (!memory) {
        const text = `NO MEMORY FOUND for key "${key}". Pass \`query\` to search by meaning, or use rigour_remember to store it.${await getIndexHealthBlock(cwd)}`;
        return wrapRecallResult(text, candidateText, 'miss');
    }
    const blocked = await blockedReason(cwd, memory);
    if (blocked) return { content: [{ type: 'text', text: blocked }] };
    const text = `RECALLED MEMORY [${key}] (${memory.scope}):\n${memory.value}\n\n(Stored: ${memory.timestamp})${await getIndexHealthBlock(cwd)}`;
    return wrapRecallResult(text, candidateText, 'miss', 0, guidance(key, `Apply recalled memory "${key}" where relevant.`, [key]));
}

async function recallQuery(cwd: string, query: string, entries: MemoryEntry[], candidateText: string): Promise<ToolResult> {
    const clean = await cleanEntries(cwd, entries);
    const [ranked, team] = await Promise.all([rankMemories(query, clean), searchTeamKnowledge(query, 3)]);
    const sections: string[] = [];
    if (ranked.length) {
        sections.push(`MEMORIES MATCHING "${query}":\n\n` + ranked.map(m =>
            `## ${m.key} (${m.scope}, ${m.match} ${m.score.toFixed(2)})\n${m.value}`).join('\n\n'));
    }
    if (team.status === 'ready' && team.candidates.length) {
        sections.push('TEAM KNOWLEDGE (promoted lessons):\n\n' + team.candidates.map(c =>
            `- ${c.subject} (similarity ${c.similarity.toFixed(2)}, ${c.state})`).join('\n'));
    }
    const text = sections.length
        ? `${sections.join('\n\n---\n\n')}\n\nApply these where they fit the task.`
        : `NO MEMORY MATCHES "${query}". Recall with no arguments lists every memory.`;
    const keys = ranked.map(m => m.key);
    return wrapRecallResult(text, candidateText, 'miss', 0, guidance(query, `Apply ${keys.length + team.candidates.length} matching memory item(s).`, keys));
}

async function recallAll(cwd: string, entries: MemoryEntry[], candidateText: string): Promise<ToolResult> {
    if (entries.length === 0) {
        return wrapRecallResult(`NO MEMORIES STORED. Use rigour_remember to persist important instructions.${await getIndexHealthBlock(cwd)}`, candidateText, 'miss');
    }
    const clean = await cleanEntries(cwd, entries);
    const blocked = entries.filter(e => !clean.includes(e)).map(e => e.key);
    let text = blocked.length ? `🛑 ${blocked.length} memory(ies) BLOCKED — contain credentials: ${blocked.join(', ')}\nUse rigour_forget to remove them.\n\n---\n\n` : '';
    text += clean.length
        ? `RECALLED ${clean.length} CLEAN MEMORIES:\n\n${clean.map(m => `## ${m.key} (${m.scope})\n${m.value}\n(Stored: ${m.timestamp})`).join('\n\n---\n\n')}\n\n---\nIMPORTANT: Follow these stored instructions throughout this session.`
        : 'No clean memories to recall. All stored memories contain credentials.';
    text += await getIndexHealthBlock(cwd);
    return wrapRecallResult(text, candidateText, 'miss', 0, guidance('all memories', `Apply ${clean.length} recalled memory item(s) where relevant.`, clean.map(m => m.key)));
}

/** Memories with no credential in them; a blocked one is audited, and never returned. */
async function cleanEntries(cwd: string, entries: MemoryEntry[]): Promise<MemoryEntry[]> {
    const clean: MemoryEntry[] = [];
    for (const entry of entries) {
        if (!(await blockedReason(cwd, entry))) clean.push(entry);
    }
    return clean;
}

async function blockedReason(cwd: string, memory: MemoryEntry): Promise<string | undefined> {
    const dlp = scanInputForCredentials(memory.value);
    if (dlp.status !== 'blocked') return undefined;
    await appendDLPAudit(cwd, { ...createDLPAuditEntry(dlp, { agent: 'rigour_recall' }), memory_key: memory.key, action: 'recall_blocked' });
    return `🛑 RECALL BLOCKED — memory "${memory.key}" contains ${dlp.detections.length} credential(s).\n\n${formatDLPAlert(dlp)}\n\nRemove it with rigour_forget("${memory.key}") and use environment variables instead.`;
}

function guidance(query: string, recommendation: string, keys: string[]): GuidanceMeta {
    return { kind: 'memory', query, recommendation, memoryRefs: keys.map(id => ({ id, label: id })) };
}
