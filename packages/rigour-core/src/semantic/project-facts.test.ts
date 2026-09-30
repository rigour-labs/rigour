import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectFacts } from './project-facts.js';

let root: string | undefined;
afterEach(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); root = undefined; });

function write(files: Record<string, string>): string {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'project-facts-'));
    for (const [name, text] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
        fs.writeFileSync(path.join(root, name), text);
    }
    return root;
}

describe('ProjectFacts', () => {
    it('reads the nearest package.json, so each monorepo package is judged by its own', () => {
        const dir = write({
            'package.json': JSON.stringify({ name: 'root', devDependencies: { vite: '^5.0.0' } }),
            'packages/ui/package.json': JSON.stringify({ name: '@x/ui', peerDependencies: { 'solid-js': '^1.8.0' } }),
            'packages/ui/src/a.tsx': '',
        });
        const facts = new ProjectFacts(dir);
        expect(facts.declares('packages/ui/src/a.tsx', 'solid-js')).toBe(true);
        expect(facts.declares('packages/ui/src/a.tsx', 'vite')).toBe(false);
        expect(facts.majorVersion('packages/ui/src/a.tsx', 'solid-js')).toBe(1);
        expect(facts.packageName('packages/ui/src/a.tsx')).toBe('@x/ui');
        expect(facts.packageDir('packages/ui/src/a.tsx')).toBe(path.join(dir, 'packages/ui'));
    });

    it('never reads a manifest above cwd', () => {
        const dir = write({ 'package.json': JSON.stringify({ dependencies: { react: '^19.0.0' } }), 'app/src/a.tsx': '' });
        const facts = new ProjectFacts(path.join(dir, 'app'));
        expect(facts.dependencies('src/a.tsx').size).toBe(0);
        expect(facts.packageDir('src/a.tsx')).toBeUndefined();
    });

    it('resolves compiler options through tsconfig extends', () => {
        const dir = write({
            'tsconfig.base.json': JSON.stringify({ compilerOptions: { stripInternal: true } }),
            'pkg/tsconfig.json': JSON.stringify({ extends: '../tsconfig.base.json' }),
            'pkg/src/a.ts': '',
        });
        expect(new ProjectFacts(dir).compilerOptions('pkg/src/a.ts').stripInternal).toBe(true);
    });
});
