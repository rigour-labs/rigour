import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { exportTrainingSitesCommand } from './export-training-sites.js';

describe('rigour export-training-sites', () => {
    let repo: string | undefined;
    afterEach(() => { if (repo) fs.rmSync(repo, { recursive: true, force: true }); repo = undefined; vi.restoreAllMocks(); });

    it('writes one JSON line per awaited call in tracked source files, skipping tests', () => {
        repo = fs.mkdtempSync(path.join(os.tmpdir(), 'sites-cli-'));
        execFileSync('git', ['init', '-q'], { cwd: repo });
        fs.mkdirSync(path.join(repo, 'src'));
        fs.writeFileSync(path.join(repo, 'src/load.ts'), 'declare function get(): Promise<number>;\nexport async function load() { return await get(); }\n');
        fs.writeFileSync(path.join(repo, 'src/load.test.ts'), 'declare function get(): Promise<number>;\nexport async function t() { return await get(); }\n');
        execFileSync('git', ['add', '-A'], { cwd: repo });
        const out: string[] = [];
        vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => { out.push(String(chunk)); return true; });

        exportTrainingSitesCommand(repo, []);

        const sites = out.join('').trim().split('\n').map(line => JSON.parse(line));
        expect(sites).toEqual([expect.objectContaining({ file: 'src/load.ts', function: 'load', callee: 'get', ordinal: 0, handledBy: null, line: 2 })]);
        expect(sites[0].source).toContain('return await get()');
    });
});
