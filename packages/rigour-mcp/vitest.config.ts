import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        setupFiles: ['./vitest.setup.ts'],
        // Windows runners spawn processes and touch files several times slower; the agent-loop integration test passes
        // the 5s default elsewhere and exceeds it there. A real hang still fails on Linux and macOS.
        testTimeout: process.platform === 'win32' ? 30_000 : 5_000,
    },
});
