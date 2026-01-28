import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        setupFiles: ['./vitest.setup.ts'],
        deps: {
            external: ['@xenova/transformers', 'sharp'],
        },
    },
});
