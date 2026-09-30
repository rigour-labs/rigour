import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import type { InferenceProvider } from '../../inference/types.js';
import { runDiffTests } from './run.js';

// The workspace root's node_modules, where the vitest binary is installed.
const WORKSPACE_MODULES = path.resolve(__dirname, '../../../../../node_modules');
let repo: string | undefined;
afterEach(() => { if (repo) fs.rmSync(repo, { recursive: true, force: true }); repo = undefined; });

const BEFORE = "export function encodePath(p: string): string {\n  return p.replace(/ /g, '%20').replace(/#/g, '%23');\n}\n";
const AFTER = "export function encodePath(p: string): string {\n  return p.replace(/#/g, '%23');\n}\n";

function repoWithChange(): string {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'diff-tests-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo! });
    git('init', '-q');
    git('config', 'user.email', 't@example.com'); git('config', 'user.name', 't'); git('config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'paths', type: 'module', devDependencies: { vitest: '*' } }));
    fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules\n');
    fs.mkdirSync(path.join(repo, 'src'));
    fs.writeFileSync(path.join(repo, 'src/encode.ts'), BEFORE);
    git('add', '-A'); git('commit', '-qm', 'init');
    fs.symlinkSync(WORKSPACE_MODULES, path.join(repo, 'node_modules'), 'dir');
    fs.writeFileSync(path.join(repo, 'src/encode.ts'), AFTER);
    return repo;
}

function provider(calls: string[], intended = false): InferenceProvider {
    return {
        name: 'fake', isAvailable: async () => true, setup: async () => {}, dispose: () => {},
        analyze: async (prompt: string) => prompt.includes('"intended"') ? JSON.stringify({ intended }) : JSON.stringify({ calls }),
    };
}

describe('runDiffTests', () => {
    it('reports a call whose outcome changed between the base and the change', async () => {
        const cwd = repoWithChange();
        const changes = await runDiffTests({
            cwd, baseRef: 'HEAD', focusLines: { 'src/encode.ts': [2] }, inference: {},
            provider: provider(["encodePath('/a b')", "encodePath('/x#y')", "process.exit(1)"]),
        });
        expect(changes).toEqual([{
            file: 'src/encode.ts', line: 2, name: 'encodePath', call: "encodePath('/a b')",
            before: 'returns "/a%20b"', after: 'returns "/a b"',
        }]);
        expect(fs.readdirSync(path.join(cwd, 'src'))).toEqual(['encode.ts']);
    }, 60_000);

    it('drops a change the PR description says is intended', async () => {
        const cwd = repoWithChange();
        const changes = await runDiffTests({
            cwd, baseRef: 'HEAD', focusLines: { 'src/encode.ts': [2] }, inference: {}, prBody: 'Stop encoding spaces.',
            provider: provider(["encodePath('/a b')"], true),
        });
        expect(changes).toEqual([]);
    }, 60_000);
});
