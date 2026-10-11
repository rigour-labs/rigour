import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        // The sources only: vitest 4 no longer leaves dist/ out by default, and a build there holds compiled copies of the tests.
        include: ['src/**/*.test.ts'],
        setupFiles: ['./vitest.setup.ts'],
        // Child processes, not worker threads: each test file gets a whole process, so nothing a file leaves open (a
        // database, a native module) is torn down under it, and a crash stays in that file.
        pool: 'forks',
        // Windows runners spawn processes and touch files several times slower; the agent-loop integration test passes
        // the 5s default elsewhere and exceeds it there. A real hang still fails on Linux and macOS.
        testTimeout: process.platform === 'win32' ? 30_000 : 5_000,
    },
});
