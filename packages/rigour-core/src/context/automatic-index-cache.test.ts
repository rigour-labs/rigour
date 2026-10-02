import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const writes = vi.hoisted(() => ({ count: 0 }));
vi.mock('../storage/context-telemetry.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../storage/context-telemetry.js')>()),
    setContextCacheRecord: async () => { writes.count++; },
}));

const { ensureAutomaticIndex, updateAutomaticIndexForFiles } = await import('./automatic-index.js');

let cwd: string;
beforeEach(() => {
    writes.count = 0;
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-index-'));
    fs.mkdirSync(path.join(cwd, 'src'));
    fs.writeFileSync(path.join(cwd, 'src/a.ts'), 'export function alpha() { return 1; }\n');
    fs.writeFileSync(path.join(cwd, 'src/b.ts'), 'export function beta() { return 2; }\n');
});
afterEach(() => fs.rmSync(cwd, { recursive: true, force: true }));

describe('automatic indexing', () => {
    it('writes nothing to the context cache, however many edits it sees', async () => {
        await ensureAutomaticIndex(cwd, { backgroundSemantic: false });
        for (let edit = 0; edit < 5; edit++) {
            fs.writeFileSync(path.join(cwd, 'src/a.ts'), `export function alpha() { return ${edit}; }\n`);
            await updateAutomaticIndexForFiles(cwd, ['src/a.ts']);
        }
        expect(writes.count).toBe(0);
        expect(fs.existsSync(path.join(cwd, '.rigour', 'patterns.json'))).toBe(true);
    });
});
