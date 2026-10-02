/**
 * What Rigour knows about this repository, for the dashboard's knowledge line:
 * read from the stores the learning features write, after every tool call.
 * Each count is cheap (small JSON files, one local lesson query, the index
 * stats) and any store that cannot be read counts as zero.
 */
import { checkPrecisions, listKnowledgeLessons, loadLearnedRules } from '@rigour-labs/core';
import { getDefaultIndexPath, loadPatternIndex } from '@rigour-labs/core/pattern-index';
import { loadMemory } from '../utils/config.js';

export interface KnowledgeSummary {
    memories: number;
    lessons: number;
    /** Lessons agents may act on: validated by repeated fixes, or promoted by a person. */
    trustedLessons: number;
    learnedRules: number;
    indexedPatterns: number;
    mutedChecks: number;
}

/** Summaries per repository for a short while: tool calls come in bursts and the counts change slowly. */
const SUMMARY_TTL_MS = 30_000;
const summaries = new Map<string, { at: number; summary: KnowledgeSummary }>();

/** Tools that change what Rigour knows: after them the summary is recomputed, never served from cache. */
export const LEARNING_TOOLS = new Set(['rigour_remember', 'rigour_forget', 'rigour_index', 'rigour_review', 'rigour_review_ack']);

export async function summarizeKnowledge(cwd: string, options: { fresh?: boolean; now?: number } = {}): Promise<KnowledgeSummary> {
    const now = options.now ?? Date.now();
    const cached = summaries.get(cwd);
    if (!options.fresh && cached && now - cached.at < SUMMARY_TTL_MS) return cached.summary;
    const summary = await computeSummary(cwd);
    summaries.set(cwd, { at: now, summary });
    return summary;
}

async function computeSummary(cwd: string): Promise<KnowledgeSummary> {
    const [repo, user, lessons, index] = await Promise.all([
        loadMemory(cwd, 'repo').catch(() => ({ memories: {} })),
        loadMemory(cwd, 'user').catch(() => ({ memories: {} })),
        listKnowledgeLessons(cwd).catch(() => []),
        loadPatternIndex(getDefaultIndexPath(cwd)).catch(() => null),
    ]);
    return {
        memories: new Set([...Object.keys(repo.memories), ...Object.keys(user.memories)]).size,
        lessons: lessons.length,
        trustedLessons: lessons.filter(l => l.state === 'validated' || l.state === 'promoted').length,
        learnedRules: safeCount(() => loadLearnedRules(cwd).length),
        indexedPatterns: index?.stats.totalPatterns ?? 0,
        mutedChecks: safeCount(() => checkPrecisions(cwd).filter(c => c.muted).length),
    };
}

function safeCount(count: () => number): number {
    try {
        return count();
    } catch {
        return 0;
    }
}
