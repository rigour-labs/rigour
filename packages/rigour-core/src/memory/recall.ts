/**
 * Recall by meaning: the few memories that match what an agent is about to do,
 * instead of every memory at once.
 *
 * Ranking uses the same local embedding model as the pattern index and team
 * knowledge (all-MiniLM-L6-v2, loaded lazily so its native dependency never
 * loads for anything else). When the model is unavailable it falls back to
 * keyword overlap and says so in each result's `match`.
 */

export type MemoryScope = 'repo' | 'user';

export interface MemoryEntry {
    scope: MemoryScope;
    key: string;
    value: string;
    timestamp?: string;
}

export interface RankedMemory extends MemoryEntry {
    score: number;
    match: 'semantic' | 'keyword';
}

/**
 * The similarity a memory needs to be returned, for local memory and team knowledge alike. Measured
 * with scripts/eval/memory-recall.mjs: at 0.25 recall and precision are both 81% and no unrelated
 * query gets anything; at the previous 0.45, 62% of right memories were missed.
 */
export const SEMANTIC_FLOOR = 0.25;
/** Share of the query's words a memory must contain when ranking falls back to keywords. */
export const KEYWORD_FLOOR = 0.5;
export const RECALL_LIMIT = 3;
/** Memories considered per recall; more are skipped so a large store cannot stall an agent. */
const MAX_CANDIDATES = 300;

type Embed = (text: string) => Promise<number[]>;

export async function rankMemories(query: string, entries: MemoryEntry[], embed?: Embed): Promise<RankedMemory[]> {
    const candidates = entries.slice(0, MAX_CANDIDATES);
    const embedText = embed ?? (await import('../pattern-index/embeddings.js')).generateEmbedding;
    const queryVector = await embedText(query);
    const ranked = queryVector.length > 0
        ? await bySimilarity(queryVector, candidates, embedText)
        : byKeywords(query, candidates);
    return ranked.sort((a, b) => b.score - a.score).slice(0, RECALL_LIMIT);
}

async function bySimilarity(queryVector: number[], entries: MemoryEntry[], embed: Embed): Promise<RankedMemory[]> {
    const ranked: RankedMemory[] = [];
    for (const entry of entries) {
        const score = cosine(queryVector, await embed(memoryText(entry)));
        if (score >= SEMANTIC_FLOOR) ranked.push({ ...entry, score, match: 'semantic' });
    }
    return ranked;
}

function byKeywords(query: string, entries: MemoryEntry[]): RankedMemory[] {
    const wanted = words(query);
    if (wanted.size === 0) return [];
    return entries.flatMap(entry => {
        const have = words(memoryText(entry));
        const score = [...wanted].filter(word => have.has(word)).length / wanted.size;
        return score >= KEYWORD_FLOOR ? [{ ...entry, score, match: 'keyword' as const }] : [];
    });
}

/** What a memory is searched by: its key reads as a title (`db_access` → "db access"). */
export function memoryText(entry: Pick<MemoryEntry, 'key' | 'value'>): string {
    return `${entry.key.replace(/[_-]+/g, ' ')}: ${entry.value}`;
}

const STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'how', 'what', 'when', 'use', 'our', 'are', 'not']);

function words(text: string): Set<string> {
    return new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter(word => word.length > 2 && !STOP_WORDS.has(word)));
}

function cosine(a: number[], b: number[]): number {
    if (a.length === 0 || a.length !== b.length) return 0;
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    return normA && normB ? dot / Math.sqrt(normA * normB) : 0;
}
