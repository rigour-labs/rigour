import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        setupFiles: ['./vitest.setup.ts'],
        // Child processes, not worker threads: each test file gets a whole process, so nothing a file leaves open (a
        // database, a native module) is torn down under it, and a crash stays in that file.
        pool: 'forks',
        // Windows runners spawn processes and touch files several times slower; tests that run every gate or a
        // real git repository pass the 5s default elsewhere and exceed it there. A real hang still fails on Linux and macOS.
        testTimeout: process.platform === 'win32' ? 30_000 : 5_000,
    },
});
