/**
 * rigour_recall: memories back to the agent.
 *
 * - `key`: that memory, from this repository, else from the user's own memory.
 * - `query`: the few memories that match by meaning (local, see core
 *   memory/recall.ts); lessons this machine has validated or a person promoted,
 *   such as a kind of defect agents keep fixing; and team knowledge from
 *   pgvector when team mode is on, never a teammate's unreviewed candidate.
 * - neither: every repository and user memory, as an agent loads at the start, and the lessons this machine holds
 *   that an agent may act on (validated, or promoted by a person, the team's included).
 *
 * In team mode a machine that has never pulled waits a moment for the first team sync (utils/team-pull.ts), and says
 * so when the team's lessons are still on their way or could not be fetched, never "nothing" from an empty store.
 *
 * Every returned memory passes the credential scan first; nothing is cached.
 */
import { formatDLPAlert, createDLPAuditEntry, isTrustedLesson, listKnowledgeLessons, loadTeamConfiguration, rankByMeaning, rankMemories, recordLessonsServed, scanInputForCredentials, searchTeamKnowledge, type MemoryEntry } from '@rigour-labs/core';
import { loadMemory } from '../utils/config.js';
import { teamLessonsFor, type TeamLessonsState } from '../utils/team-pull.js';
import type { GuidanceMeta, ToolResult } from '../utils/context-telemetry.js';
import { appendDLPAudit, getIndexHealthBlock, wrapRecallResult } from './memory-handlers.js';

export interface RecallArgs {
    key?: string;
    query?: string;
}

/** `teamWaitMs`: how long to wait for the first team sync on a machine that has never pulled (the default unless a test shortens it). */
export async function handleRecall(cwd: string, args: RecallArgs = {}, options: { teamWaitMs?: number } = {}): Promise<ToolResult> {
    const entries = await localEntries(cwd);
    const candidateText = JSON.stringify(entries);
    if (args.key) return recallKey(cwd, args.key, entries, candidateText);
    const team = await teamLessonsFor(cwd, options.teamWaitMs);
    if (args.query?.trim()) return recallQuery(cwd, args.query.trim(), entries, candidateText, team);
    return recallAll(cwd, entries, candidateText, team);
}

/** What a recall adds when the team's lessons are not in the local store yet. */
function teamNote(team: TeamLessonsState): string {
    if (team.state === 'syncing') return "\n\nThe team's lessons are still being fetched from the team database; recall again in a moment for them.";
    if (team.state === 'failed') return `\n\nThe team's lessons could not be fetched from the team database (${team.reason}); recall again to retry, or run \`rigour team doctor\`.`;
    return '';
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

async function recallQuery(cwd: string, query: string, entries: MemoryEntry[], candidateText: string, teamState: TeamLessonsState): Promise<ToolResult> {
    const clean = await cleanEntries(cwd, entries);
    const [ranked, lessons, team] = await Promise.all([
        rankMemories(query, clean),
        rankByMeaning(query, await trustedLessons(cwd), lesson => lesson.subject),
        searchTeamKnowledge(query, 3),
    ]);
    const teamOnly = team.status === 'ready' ? team.candidates.filter(c => !lessons.some(l => l.id === c.lessonId)) : [];
    recordLessonsServed(cwd, 'recall', [...lessons.map(l => l.subject), ...teamOnly.map(c => c.subject)]);
    const sections: string[] = [];
    if (ranked.length) {
        sections.push(`MEMORIES MATCHING "${query}":\n\n` + ranked.map(m =>
            `## ${m.key} (${m.scope}, ${m.match} ${m.score.toFixed(2)})\n${m.value}`).join('\n\n'));
    }
    if (lessons.length) {
        sections.push('LESSONS (validated by repeated fixes, or promoted):\n\n' + lessons.map(l =>
            `- ${l.subject} (${l.state}, ${l.match} ${l.score.toFixed(2)})`).join('\n'));
    }
    if (teamOnly.length) {
        sections.push('TEAM KNOWLEDGE (promoted lessons):\n\n' + teamOnly.map(c =>
            `- ${c.subject} (similarity ${c.similarity.toFixed(2)}, ${c.state})`).join('\n'));
    }
    const text = (sections.length
        ? `${sections.join('\n\n---\n\n')}\n\nApply these where they fit the task.`
        : `NO MEMORY MATCHES "${query}". Recall with no arguments lists every memory.`) + teamNote(teamState);
    const keys = ranked.map(m => m.key);
    return wrapRecallResult(text, candidateText, 'miss', 0, guidance(query, `Apply ${keys.length + lessons.length + teamOnly.length} matching item(s).`, keys));
}

async function recallAll(cwd: string, entries: MemoryEntry[], candidateText: string, team: TeamLessonsState): Promise<ToolResult> {
    const lessons = (await trustedLessons(cwd)).slice(0, MAX_LISTED_LESSONS);
    if (entries.length === 0 && lessons.length === 0) {
        return wrapRecallResult(`NO MEMORIES STORED. Use rigour_remember to persist important instructions.${teamNote(team)}${await getIndexHealthBlock(cwd)}`, candidateText, 'miss');
    }
    const clean = await cleanEntries(cwd, entries);
    const blocked = entries.filter(e => !clean.includes(e)).map(e => e.key);
    const sections: string[] = [];
    if (blocked.length) sections.push(`🛑 ${blocked.length} memory(ies) BLOCKED — contain credentials: ${blocked.join(', ')}\nUse rigour_forget to remove them.`);
    if (clean.length) sections.push(`RECALLED ${clean.length} CLEAN MEMORIES:\n\n${clean.map(m => `## ${m.key} (${m.scope})\n${m.value}\n(Stored: ${m.timestamp})`).join('\n\n---\n\n')}`);
    else if (entries.length) sections.push('No clean memories to recall. All stored memories contain credentials.');
    if (lessons.length) sections.push(`LESSONS (validated by repeated fixes, or promoted by a person, the team's included):\n\n${lessons.map(l => `- ${l.subject} (${l.state})`).join('\n')}`);
    let text = sections.join('\n\n---\n\n');
    if (clean.length || lessons.length) text += '\n\n---\nIMPORTANT: Follow these stored instructions throughout this session.';
    text += teamNote(team);
    text += await getIndexHealthBlock(cwd);
    return wrapRecallResult(text, candidateText, 'miss', 0, guidance('all memories', `Apply ${clean.length + lessons.length} recalled item(s) where relevant.`, clean.map(m => m.key)));
}

/** The most lessons a recall with no arguments lists, most recently updated first. */
const MAX_LISTED_LESSONS = 20;

/** Lessons an agent may act on: validated by evidence, or promoted by a person (a teammate's only once promoted). */
async function trustedLessons(cwd: string) {
    const own = (await loadTeamConfiguration().catch(() => null))?.actorId;
    return (await listKnowledgeLessons(cwd)).filter(lesson => isTrustedLesson(lesson, own));
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
