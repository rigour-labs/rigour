/**
 * SvelteKit on a fresh clone: `.svelte-kit/` (and its tsconfig with the
 * `$lib` alias) does not exist until `svelte-kit sync` runs.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HallucinatedImportsGate } from './hallucinated-imports/index.js';

function write(root: string, rel: string, body: string): void {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
}

async function missingImports(cwd: string): Promise<string> {
    const failures = await new HallucinatedImportsGate().run({ cwd });
    return failures.map(f => f.details).join('\n');
}

describe('HallucinatedImportsGate — SvelteKit', () => {
    let cwd: string;

    beforeEach(() => {
        cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-imports-'));
        write(cwd, 'package.json', JSON.stringify({ devDependencies: { '@sveltejs/kit': '2.0.0', svelte: '5.0.0' } }));
        write(cwd, 'tsconfig.json', JSON.stringify({ extends: './.svelte-kit/tsconfig.json' }));
        write(cwd, 'src/lib/format.ts', 'export const format = (n: number) => String(n);\n');
        write(cwd, 'src/lib/components/badge.svelte', '<span><slot /></span>\n');
    });
    afterEach(() => { fs.rmSync(cwd, { recursive: true, force: true }); });

    it('accepts kit virtual modules, generated $types, $lib and .svelte imports without svelte-kit sync', async () => {
        write(cwd, 'src/routes/+page.ts', [
            "import { goto } from '$app/navigation';",
            "import { page } from '$app/state';",
            "import { PUBLIC_API_URL } from '$env/static/public';",
            "import { env } from '$env/dynamic/private';",
            "import type { PageLoad } from './$types';",
            "import { format } from '$lib/format';",
            "import Badge from '$lib/components/badge.svelte';",
            "import Local from '../lib/components/badge.svelte';",
            'export const load: PageLoad = () => ({ goto, page, PUBLIC_API_URL, env, format, Badge, Local });',
        ].join('\n'));

        expect(await missingImports(cwd)).toBe('');
    });

    it('still flags a $lib import that points at no file', async () => {
        write(cwd, 'src/routes/+page.ts', "import { gone } from '$lib/does-not-exist';\nexport const x = gone;\n");
        expect(await missingImports(cwd)).toContain("'$lib/does-not-exist'");
    });

    it('still flags a missing relative .svelte component', async () => {
        write(cwd, 'src/routes/+page.ts', "import Missing from './missing.svelte';\nexport const x = Missing;\n");
        expect(await missingImports(cwd)).toContain("'./missing.svelte'");
    });

    it('still flags a real missing package in a kit project', async () => {
        write(cwd, 'src/routes/+page.ts', "import made from 'package-that-does-not-exist';\nexport const x = made;\n");
        expect(await missingImports(cwd)).toContain("'package-that-does-not-exist'");
    });

    it('does not treat $app or $lib as provided outside a SvelteKit project', async () => {
        write(cwd, 'package.json', JSON.stringify({ dependencies: {} }));
        write(cwd, 'src/index.ts', "import { goto } from '$app/navigation';\nimport { format } from '$lib/format';\nexport const x = [goto, format];\n");
        const details = await missingImports(cwd);
        expect(details).toContain("'$app/navigation'");
        expect(details).toContain("'$lib/format'");
    });

    it('resolves a $lib import written with the emitted .js extension to its .ts source', async () => {
        write(cwd, 'src/lib/utils.ts', 'export const cn = (...c: string[]) => c.join(" ");\n');
        write(cwd, 'src/lib/components/button-variants.ts', "import { cn } from '$lib/utils.js';\nexport const x = cn;\n");
        expect(await missingImports(cwd)).toBe('');
    });

    it('resolves a tsconfig path alias written with .js to its .ts source (any framework)', async () => {
        write(cwd, 'package.json', JSON.stringify({ dependencies: {} }));
        write(cwd, 'tsconfig.json', JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } }));
        write(cwd, 'src/util/math.ts', 'export const add = (a: number, b: number) => a + b;\n');
        write(cwd, 'src/index.ts', "import { add } from '@/util/math.js';\nexport const x = add;\n");
        expect(await missingImports(cwd)).toBe('');
    });

    it('resolves inherited paths against the config that declares them (after svelte-kit sync)', async () => {
        write(cwd, '.svelte-kit/tsconfig.json', JSON.stringify({
            compilerOptions: { paths: { $lib: ['../src/lib'], '$lib/*': ['../src/lib/*'] }, rootDirs: ['..', './types'] },
        }));
        write(cwd, 'src/routes/+page.ts', "import { format } from '$lib/format';\nimport { gone } from '$lib/does-not-exist';\nexport const x = [format, gone];\n");
        const details = await missingImports(cwd);
        expect(details).not.toContain("'$lib/format'");
        expect(details).toContain("'$lib/does-not-exist'");
    });
});

describe('HallucinatedImportsGate — tsconfig inheritance and rootDirs', () => {
    let cwd: string;
    beforeEach(() => { cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tsconfig-inherit-')); });
    afterEach(() => { fs.rmSync(cwd, { recursive: true, force: true }); });

    it('resolves paths inherited from a shared base config against that config (Nx-style)', async () => {
        write(cwd, 'package.json', JSON.stringify({ dependencies: {} }));
        write(cwd, 'libs/tsconfig.base.json', JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@org/util': ['util/src/index.ts'] } } }));
        write(cwd, 'libs/util/src/index.ts', 'export const util = 1;\n');
        write(cwd, 'apps/web/tsconfig.json', JSON.stringify({ extends: '../../libs/tsconfig.base.json' }));
        write(cwd, 'apps/web/src/main.ts', "import { util } from '@org/util';\nexport const x = util;\n");
        expect(await missingImports(cwd)).toBe('');
    });

    it('resolves a relative import through rootDirs into a generated folder', async () => {
        write(cwd, 'package.json', JSON.stringify({ dependencies: {} }));
        write(cwd, 'tsconfig.json', JSON.stringify({ compilerOptions: { rootDirs: ['src', 'generated'] } }));
        write(cwd, 'generated/schema.ts', 'export const schema = {};\n');
        write(cwd, 'src/api.ts', "import { schema } from './schema';\nexport const x = schema;\n");
        expect(await missingImports(cwd)).toBe('');
    });

    it('still flags a relative import found in no root', async () => {
        write(cwd, 'package.json', JSON.stringify({ dependencies: {} }));
        write(cwd, 'tsconfig.json', JSON.stringify({ compilerOptions: { rootDirs: ['src', 'generated'] } }));
        write(cwd, 'src/api.ts', "import { schema } from './nowhere';\nexport const x = schema;\n");
        expect(await missingImports(cwd)).toContain("'./nowhere'");
    });
});


describe('HallucinatedImportsGate — bundler query and virtual imports', () => {
    let cwd: string;
    beforeEach(() => {
        cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bundler-imports-'));
        write(cwd, 'package.json', JSON.stringify({ dependencies: { '@tanstack/react-router': '1.0.0' } }));
        write(cwd, 'src/logo.svg', '<svg/>');
        write(cwd, 'src/worker.ts', 'export {};\n');
    });
    afterEach(() => { fs.rmSync(cwd, { recursive: true, force: true }); });

    it('checks the file behind a query and skips plugin-provided modules', async () => {
        write(cwd, 'src/route.tsx', [
            "import raw from './logo.svg?raw';",
            "import Worker from './worker.ts?worker&inline';",
            "const split = () => import('route.tsx?tsr-split=component');",
            "import { registerSW } from 'virtual:pwa-register';",
            'export default { raw, Worker, split, registerSW };',
        ].join('\n'));
        expect(await missingImports(cwd)).toBe('');
    });

    it('still reports a missing module behind a query', async () => {
        write(cwd, 'src/route.tsx', "import Worker from './missing-worker.ts?worker';\nexport default Worker;\n");
        expect(await missingImports(cwd)).toContain('./missing-worker.ts');
    });
});
