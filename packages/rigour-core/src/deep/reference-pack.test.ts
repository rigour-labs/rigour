import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildReferencePack } from './reference-pack.js';

let repo: string | undefined;
afterEach(() => { if (repo) fs.rmSync(repo, { recursive: true, force: true }); repo = undefined; });

function project(): string {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'reference-pack-'));
    const files: Record<string, string> = {
        'src/paths.ts': "export function cleanPath(p: string): string {\n  return p.replace(/\\/+/g, '/');\n}\n",
        'src/routes.ts': "import { cleanPath } from './paths';\nexport function routePath(dir: string, route: string): string {\n  return cleanPath(`/${dir}${route}`);\n}\n",
        'src/generator.ts': "import { routePath } from './routes';\nexport const home = routePath('.', '/');\n",
    };
    for (const [name, text] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(repo, name)), { recursive: true });
        fs.writeFileSync(path.join(repo, name), text);
    }
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['add', '-A'], { cwd: repo });
    return repo;
}

describe('buildReferencePack', () => {
    it('carries the intent, removed lines, callee definitions and callers of a changed export', () => {
        const cwd = project();
        const pack = buildReferencePack({
            cwd, file: 'src/routes.ts', focusLines: [3], maxChars: 10_000,
            prBody: 'Normalize virtual route paths.',
            removed: [{ line: 3, text: ["  return `/${dir}${route}`;"] }],
        });
        expect(pack.text).toContain('PR DESCRIPTION (what the author intends):\nNormalize virtual route paths.');
        expect(pack.text).toContain('REMOVED by this change, just before line 3 of src/routes.ts:\n-   return `/${dir}${route}`;');
        expect(pack.text).toContain('CALLED: src/paths.ts:1\nexport function cleanPath');
        expect(pack.text).toContain("CALLER of routePath:\nsrc/generator.ts:2:export const home = routePath('.', '/');");
        expect(pack.source).toContain('cleanPath');
    });

    it('stays within its budget, keeping the highest-priority sections', () => {
        const cwd = project();
        const pack = buildReferencePack({ cwd, file: 'src/routes.ts', focusLines: [3], maxChars: 80, prBody: 'Normalize virtual route paths.' });
        expect(pack.text).toContain('PR DESCRIPTION');
        expect(pack.text).not.toContain('CALLED');
        expect(pack.text.length).toBeLessThanOrEqual(80);
    });
});
