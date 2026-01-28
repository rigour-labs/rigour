/**
 * Semantic Embedding Service
 * 
 * Uses Transformers.js for local vector embeddings.
 */

/**
 * Singleton for the embedding pipeline to avoid re-loading the model.
 */
let embeddingPipeline: any = null;

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

    if (!embeddingPipeline) {
        try {
            // Dynamic import to isolate native dependency issues (like sharp)
            const { pipeline, env } = await import('@xenova/transformers');

            // Disable image processing features to avoid native 'sharp' dependency issues
            env.allowImageProcessors = false;

            // Using a compact but high-quality model for local embeddings
            embeddingPipeline = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
        } catch (error) {
            console.error('Failed to initialize embedding pipeline:', error);
            throw error;
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
        const output = await extractor(text, { pooling: 'mean', normalize: true });
        return Array.from(output.data);
    } catch (error) {
        console.warn('Semantic reasoning disabled: Embedding generation failed.', error);
        return [];
    }
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
