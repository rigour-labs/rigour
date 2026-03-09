/**
 * Duplication Drift Similarity Detection
 *
 * Handles all comparison and similarity detection logic:
 * - Fingerprinting/hashing
 * - Jaccard similarity on multisets
 * - Clone detection algorithms
 * - Threshold calculations
 */

import crypto from 'crypto';
import { cosineSimilarity } from '../../pattern-index/embeddings.js';

/**
 * Represents a detected function with its signatures and comparison data.
 */
export interface FunctionSignature {
    name: string;
    file: string;
    line: number;
    paramCount: number;
    bodyHash: string;
    bodyLength: number;
    normalized: string;
    /** AST node type multiset for Jaccard comparison */
    astTokens: Map<string, number>;
    /** Semantic embedding vector (384D) for cosine similarity */
    embedding?: number[];
}

/**
 * Hash a normalized function body using MD5.
 */
export function hashBody(text: string): string {
    return crypto.createHash('md5').update(text).digest('hex');
}

/**
 * Jaccard similarity on multisets.
 * intersection = sum of min(countA, countB) for each key
 * union = sum of max(countA, countB) for each key
 */
export function jaccardSimilarity(a: Map<string, number>, b: Map<string, number>): number {
    const allKeys = new Set([...a.keys(), ...b.keys()]);
    let intersection = 0;
    let union = 0;

    for (const key of allKeys) {
        const countA = a.get(key) || 0;
        const countB = b.get(key) || 0;
        intersection += Math.min(countA, countB);
        union += Math.max(countA, countB);
    }

    return union === 0 ? 0 : intersection / union;
}

/**
 * Generate semantic embedding text for a function.
 * Combines function name, parameter names, and first 200 tokens of body.
 * This captures INTENT regardless of implementation differences.
 *
 * Example:
 * getUserById(id) { return db.users.find(x => x.id === id) }
 * → "getUserById id return db users find x id id"
 *
 * fetchUserRecord(userId) { return database.users.filter(u => u.id === userId)[0] }
 * → "fetchUserRecord userId return database users filter u id userId 0"
 *
 * These produce similar embeddings (~0.91 cosine) despite different AST.
 */
export function buildEmbeddingText(fn: FunctionSignature): string {
    // Extract identifiers from normalized body (first 200 tokens)
    const bodyTokens = fn.normalized.match(/\b[a-zA-Z_]\w*\b/g) || [];
    const first200 = bodyTokens.slice(0, 200).join(' ');
    return `${fn.name} ${first200}`;
}

/**
 * Calculate similarity between two functions using all available methods.
 * Returns { similarity, method } where method indicates which technique was used.
 */
export function calculateSimilarity(
    fn1: FunctionSignature,
    fn2: FunctionSignature
): { similarity: number; method: string } {
    // Exact hash match (Pass 1)
    if (fn1.bodyHash === fn2.bodyHash) {
        return { similarity: 1.0, method: 'exact-hash' };
    }

    // Semantic embedding comparison (if available)
    if (fn1.embedding && fn2.embedding) {
        const jaccardSim = jaccardSimilarity(fn1.astTokens, fn2.astTokens);
        const cosineSim = cosineSimilarity(fn1.embedding, fn2.embedding);
        if (cosineSim > jaccardSim) {
            return { similarity: cosineSim, method: 'semantic-embedding' };
        }
    }

    // AST Jaccard similarity (Pass 2)
    const jaccardSim = jaccardSimilarity(fn1.astTokens, fn2.astTokens);
    return { similarity: jaccardSim, method: 'ast-jaccard' };
}

/**
 * Three-pass duplicate detection:
 * Pass 1 (fast):     MD5 hash → exact duplicates (O(n))
 * Pass 2 (Jaccard):  AST node multiset similarity → near-duplicates (O(n²) bounded)
 * Pass 3 (semantic):  Embedding cosine similarity → semantic duplicates (O(n²) bounded)
 *
 * Pass 3 catches what AST Jaccard misses: same intent, different implementation.
 * Example: .find() vs .filter()[0] — different AST nodes, same semantic meaning.
 */
export function findDuplicateGroups(
    functions: FunctionSignature[],
    similarityThreshold: number,
    semanticThreshold: number,
    semanticEnabled: boolean
): FunctionSignature[][] {
    const duplicates: FunctionSignature[][] = [];
    const claimedIndices = new Set<number>();

    // Pass 1: Exact hash match
    const hashGroups = new Map<string, number[]>();
    for (let i = 0; i < functions.length; i++) {
        const existing = hashGroups.get(functions[i].bodyHash) || [];
        existing.push(i);
        hashGroups.set(functions[i].bodyHash, existing);
    }

    for (const indices of hashGroups.values()) {
        if (indices.length < 2) continue;
        const group = indices.map(i => functions[i]);
        const uniqueFiles = new Set(group.map(f => f.file));
        if (uniqueFiles.size >= 2) {
            duplicates.push(group);
            indices.forEach(i => claimedIndices.add(i));
        }
    }

    // Pass 2: Jaccard on AST tokens for remaining functions
    const remaining = functions
        .map((fn, i) => ({ fn, idx: i }))
        .filter(({ idx }) => !claimedIndices.has(idx));

    remaining.sort((a, b) => a.fn.bodyLength - b.fn.bodyLength);

    const jaccardClaimed = new Set<number>();

    for (let i = 0; i < remaining.length; i++) {
        if (jaccardClaimed.has(remaining[i].idx)) continue;

        const group: FunctionSignature[] = [remaining[i].fn];
        const baseLen = remaining[i].fn.bodyLength;

        for (let j = i + 1; j < remaining.length; j++) {
            if (jaccardClaimed.has(remaining[j].idx)) continue;
            if (remaining[j].fn.bodyLength > baseLen * 1.5) break;
            if (remaining[j].fn.file === remaining[i].fn.file) continue;

            const sim = jaccardSimilarity(remaining[i].fn.astTokens, remaining[j].fn.astTokens);
            if (sim >= similarityThreshold) {
                group.push(remaining[j].fn);
                jaccardClaimed.add(remaining[j].idx);
            }
        }

        if (group.length >= 2) {
            const uniqueFiles = new Set(group.map(f => f.file));
            if (uniqueFiles.size >= 2) {
                duplicates.push(group);
                jaccardClaimed.add(remaining[i].idx);
            }
        }
    }

    // Mark all Pass 1 + Pass 2 claimed indices
    for (const idx of jaccardClaimed) claimedIndices.add(idx);

    // Pass 3: Semantic embedding cosine similarity for still-unclaimed functions
    if (semanticEnabled) {
        const semanticRemaining = functions
            .map((fn, i) => ({ fn, idx: i }))
            .filter(({ idx }) => !claimedIndices.has(idx))
            .filter(({ fn }) => fn.embedding && fn.embedding.length > 0);

        semanticRemaining.sort((a, b) => a.fn.bodyLength - b.fn.bodyLength);

        const semanticClaimed = new Set<number>();

        for (let i = 0; i < semanticRemaining.length; i++) {
            if (semanticClaimed.has(semanticRemaining[i].idx)) continue;

            const group: FunctionSignature[] = [semanticRemaining[i].fn];
            const baseLen = semanticRemaining[i].fn.bodyLength;

            for (let j = i + 1; j < semanticRemaining.length; j++) {
                if (semanticClaimed.has(semanticRemaining[j].idx)) continue;
                // Body length must be within 2x range (semantic allows more variance)
                if (semanticRemaining[j].fn.bodyLength > baseLen * 2.0) break;
                if (semanticRemaining[j].fn.file === semanticRemaining[i].fn.file) continue;

                const sim = cosineSimilarity(
                    semanticRemaining[i].fn.embedding!,
                    semanticRemaining[j].fn.embedding!
                );
                if (sim >= semanticThreshold) {
                    group.push(semanticRemaining[j].fn);
                    semanticClaimed.add(semanticRemaining[j].idx);
                }
            }

            if (group.length >= 2) {
                const uniqueFiles = new Set(group.map(f => f.file));
                if (uniqueFiles.size >= 2) {
                    duplicates.push(group);
                    semanticClaimed.add(semanticRemaining[i].idx);
                }
            }
        }
    }

    return duplicates;
}
