/**
 * Semantic Embedding Service
 *
 * Uses Transformers.js for local vector embeddings, loaded from wherever it is installed
 * (semantic-runtime.ts). Without it, embeddings are empty and callers fall back to keywords.
 */
import { loadTransformers } from './semantic-runtime.js';

/**
 * Singleton for the embedding pipeline to avoid re-loading the model.
 */
let embeddingPipeline: any = null;
let embeddingUnavailable = false;

/**
 * Get or initialize the embedding pipeline.
 */
async function getPipeline() {
    // Definitive bypass for tests to avoid native 'sharp' dependency issues
    if (process.env.VITEST) {
        return async (text: string) => {
            const vector = new Array(384).fill(0);
            for (let i = 0; i < Math.min(text.length, 384); i++) {
                vector[i] = text.charCodeAt(i) / 255;
            }
            return { data: new Float32Array(vector) };
        };
    }

    if (embeddingUnavailable) return null;

    if (!embeddingPipeline) {
        try {
            // Loaded where it is installed; never a dependency of the npm package (semantic-runtime.ts).
            const transformers = await loadTransformers();
            if (!transformers) {
                // Not installed: keyword matching, said once by `rigour doctor`, not on every run.
                embeddingUnavailable = true;
                return null;
            }
            // Using a compact but high-quality model for local embeddings
            embeddingPipeline = await transformers.pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
        } catch (error) {
            embeddingUnavailable = true;
            console.warn('Semantic enrichment is degraded; structural and text retrieval remain available.');
            return null;
        }
    }
    return embeddingPipeline;
}

/**
 * Generate an embedding for a piece of text.
 */
export async function generateEmbedding(text: string): Promise<number[]> {
    try {
        const extractor = await getPipeline();
        if (!extractor) return [];
        const output = await extractor(text, { pooling: 'mean', normalize: true });
        return Array.from(output.data);
    } catch (error) {
        embeddingUnavailable = true;
        console.warn('Semantic enrichment is degraded; structural and text retrieval remain available.');
        return [];
    }
}

/**
 * Version of the text patterns are embedded by. An index embedded with an older text is
 * re-embedded on its next enrichment.
 *   2: the name split into words (`retryWithBackoff` → "retry with backoff"). Measured by
 *      scripts/eval/pattern-intent.mjs: recall by intent 87% at 0.30 with no false matches,
 *      against 13% for the raw name at the old 0.60 bar.
 */
export const EMBEDDING_TEXT_VERSION = 2;

export function patternEmbeddingText(pattern: { name: string; type: string; description?: string }): string {
    const words = pattern.name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').toLowerCase();
    return `${words} ${pattern.type} ${pattern.description ?? ''}`.trim();
}

/** A pattern's embedding, rounded to 4 decimals: a third of the size on disk, no change to ranking. */
export async function embedPattern(pattern: { name: string; type: string; description?: string }): Promise<number[]> {
    return (await generateEmbedding(patternEmbeddingText(pattern))).map(x => Math.round(x * 1e4) / 1e4);
}

/**
 * Calculate cosine similarity between two vectors.
 */
export function cosineSimilarity(v1: number[], v2: number[]): number {
    if (!v1 || !v2 || v1.length !== v2.length || v1.length === 0) return 0;

    let dotProduct = 0;
    let norm1 = 0;
    let norm2 = 0;

    for (let i = 0; i < v1.length; i++) {
        dotProduct += v1[i] * v2[i];
        norm1 += v1[i] * v1[i];
        norm2 += v2[i] * v2[i];
    }

    const denominator = Math.sqrt(norm1) * Math.sqrt(norm2);
    return denominator === 0 ? 0 : dotProduct / denominator;
}

/**
 * Perform semantic search against a list of embeddings.
 */
export function semanticSearch(queryVector: number[], entries: { embedding?: number[] }[]): number[] {
    return entries.map(entry => {
        if (!entry.embedding) return 0;
        return cosineSimilarity(queryVector, entry.embedding);
    });
}
