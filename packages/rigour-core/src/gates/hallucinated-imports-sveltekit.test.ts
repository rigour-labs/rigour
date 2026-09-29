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
});

