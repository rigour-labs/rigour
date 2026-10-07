import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        setupFiles: ['./vitest.setup.ts'],
        // Init tests exercise package discovery and file scaffolding. They can exceed Vitest's 5s default when all
        // workspace packages test concurrently in CI, and Windows runners spawn processes several times slower again.
        testTimeout: process.platform === 'win32' ? 30_000 : 15_000,
        deps: {
            external: ['@xenova/transformers', 'sharp'],
        },
    },
});
