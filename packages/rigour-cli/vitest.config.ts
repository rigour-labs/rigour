import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        // The sources only: vitest 4 no longer leaves dist/ out by default, and a build there holds compiled copies of the tests.
        include: ['src/**/*.test.ts'],
        setupFiles: ['./vitest.setup.ts'],
        // Child processes, not worker threads: each test file gets a whole process, so nothing a file leaves open (a
        // database, a native module) is torn down under it, and a crash stays in that file.
        pool: 'forks',
        // Init tests exercise package discovery and file scaffolding. They can exceed Vitest's 5s default when all
        // workspace packages test concurrently in CI, and Windows runners spawn processes several times slower again.
        testTimeout: process.platform === 'win32' ? 30_000 : 15_000,
        deps: {
            external: ['@xenova/transformers', 'sharp'],
        },
    },
});
