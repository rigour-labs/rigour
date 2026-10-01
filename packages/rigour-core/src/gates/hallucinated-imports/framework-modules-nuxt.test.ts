import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isNuxtProvided, NuxtRoots } from './framework-modules.js';

let dir: string;
beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nuxt-'));
    fs.mkdirSync(path.join(dir, 'docs/server/api'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'docs/package.json'), JSON.stringify({ devDependencies: { nuxt: '^4.0.0' } }));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { vue: '^3.0.0' } }));
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('Nuxt-provided modules', () => {
    it('recognises aliases, virtual modules, the generated .nuxt dir and packages Nuxt supplies', () => {
        for (const [spec, pkg] of [['~~/server/api/ai.post', '~~'], ['~/utils/x', '~'], ['@/components/A.vue', '@'], ['#imports', '#imports'], ['../../.nuxt/ui', '..'], ['h3', 'h3'], ['@vue/shared', '@vue/shared']]) {
            expect(isNuxtProvided(spec, pkg)).toBe(true);
        }
        expect(isNuxtProvided('left-pad', 'left-pad')).toBe(false);
        expect(isNuxtProvided('@scope/pkg', '@scope/pkg')).toBe(false);
    });

    it('applies only inside a project that depends on nuxt', async () => {
        const roots = new NuxtRoots(dir);
        expect(await roots.rootFor('docs/server/api/ai.post.ts')).toBe(path.join(dir, 'docs'));
        expect(await roots.rootFor('src/index.ts')).toBeNull();
    });
});
