import { vi } from 'vitest';

// Mock Transformers.js to avoid native binary dependency issues and speed up tests
vi.mock('@xenova/transformers', () => ({
    pipeline: async () => {
        // Return a mock extractor that produces deterministic "embeddings"
        return async (text: string) => {
            // Create a fake vector based on the text length or hash
            const vector = new Array(384).fill(0);
            for (let i = 0; i < Math.min(text.length, 384); i++) {
                vector[i] = text.charCodeAt(i) / 255;
            }
            return { data: new Float32Array(vector) };
        };
    },
    env: {
        allowImageProcessors: false,
    },
}));

// Also mock sharp just in case something else pulls it in
vi.mock('sharp', () => ({
    default: () => ({
        resize: () => ({
            toFormat: () => ({
                toBuffer: async () => Buffer.from([]),
            }),
        }),
    }),
}));
