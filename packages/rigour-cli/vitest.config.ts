import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        setupFiles: ['./vitest.setup.ts'],
        // Child processes, not worker threads: sqlite3 is a native addon, and a worker thread torn down while it holds an
        // open database crashes Node on Windows (napi_throw in FreeEnvironment) after every test has passed.
        pool: 'forks',
        // Init tests exercise package discovery and file scaffolding. They can exceed Vitest's 5s default when all
        // workspace packages test concurrently in CI, and Windows runners spawn processes several times slower again.
        testTimeout: process.platform === 'win32' ? 30_000 : 15_000,
        deps: {
            external: ['@xenova/transformers', 'sharp'],
        },
    },
});
