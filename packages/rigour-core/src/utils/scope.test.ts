import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isScoped, normalizeScopePatterns, resolveScopedFiles, touchesScope } from './scope.js';

describe('scope', () => {
    let cwd: string;
    beforeEach(async () => {
        cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'rigour-scope-'));
        await fs.outputFile(path.join(cwd, 'src/app/[key]/route.ts'), 'export {}');
        await fs.outputFile(path.join(cwd, 'src/app/k/route.ts'), 'export {}');
        await fs.outputFile(path.join(cwd, 'src/lib/a.ts'), 'export {}');
    });
    afterEach(async () => { await fs.remove(cwd); });

    it('turns absolute, relative and directory inputs into cwd-relative patterns', async () => {
        const patterns = await normalizeScopePatterns(cwd, [path.join(cwd, 'src/lib/a.ts'), './src/lib', 'src/lib/a.ts']);
        expect(patterns).toEqual(['src/lib/a.ts', 'src/lib/**/*', 'src/lib/a.ts']);
    });

    it('escapes glob characters so a Next.js [key] route matches only itself', async () => {
        const patterns = await normalizeScopePatterns(cwd, ['src/app/[key]/route.ts']);
        expect([...await resolveScopedFiles(cwd, patterns)]).toEqual(['src/app/[key]/route.ts']);
    });

    it('keeps a non-existent input as the glob the user wrote', async () => {
        expect(await normalizeScopePatterns(cwd, ['src/**/*.ts'])).toEqual(['src/**/*.ts']);
    });

    it('treats the repo root as everything', async () => {
        expect(await normalizeScopePatterns(cwd, ['.'])).toEqual(['**/*']);
    });

    it('detects scoped runs and scope membership', () => {
        expect(isScoped(undefined)).toBe(false);
        expect(isScoped([])).toBe(false);
        expect(isScoped(['a.ts'])).toBe(true);
        const scoped = new Set(['src/lib/a.ts']);
        expect(touchesScope(['./src/lib/a.ts', 'b.ts'], scoped)).toBe(true);
        expect(touchesScope(['b.ts'], scoped)).toBe(false);
        expect(touchesScope(undefined, scoped)).toBe(false);
    });
});
