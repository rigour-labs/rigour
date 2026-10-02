import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { groupFilesByRepo, hookFindings } from './hooks-check-repos.js';

let base: string;
const repo = (name: string) => {
    const dir = path.join(base, name);
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    execFileSync('git', ['init', '-q', dir]);
    return fs.realpathSync.native(dir);
};
beforeEach(() => { base = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-repos-')); });
afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

describe('groupFilesByRepo', () => {
    it("checks each file in its own repository, not the session's", () => {
        const app = repo('app');
        const lib = repo('lib');
        const groups = groupFilesByRepo(app, ['src/a.ts', path.join(lib, 'src/b.ts')]);
        expect(groups).toEqual([{ root: app, files: ['src/a.ts'] }, { root: lib, files: ['src/b.ts'] }]);
    });
});

describe('hookFindings', () => {
    it('keeps code findings and drops findings about the write itself', () => {
        const result = { status: 'fail' as const, duration_ms: 1, failures: [
            { gate: 'security-patterns', file: 'src/a.ts', message: 'Hard-coded secret', severity: 'critical', line: 3 },
            { gate: 'file-guard', file: '.rigour/dismissed.json', message: 'BLOCKED', severity: 'critical' },
            { gate: 'file-size', file: 'src/big.ts', message: 'Too long', severity: 'low' },
        ] };
        expect(hookFindings(result)).toEqual([expect.objectContaining({ id: 'security-patterns', title: 'Hard-coded secret', files: ['src/a.ts'], line: 3 })]);
    });
});
