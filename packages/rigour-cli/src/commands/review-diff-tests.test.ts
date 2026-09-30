import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { reviewCommand } from './review.js';

describe('rigour review --diff-tests', () => {
    let dir: string | undefined;
    afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); dir = undefined; vi.restoreAllMocks(); });

    it('refuses to run without a model that can propose test inputs', async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diff-tests-cli-'));
        fs.writeFileSync(path.join(dir, 'change.diff'), '');
        const out: string[] = [];
        vi.spyOn(console, 'log').mockImplementation((line: string) => { out.push(line); });
        const exit = vi.spyOn(process, 'exit').mockImplementation(((code: number) => { throw new Error(`exit ${code}`); }) as never);
        await expect(reviewCommand(dir, { json: true, diff: 'change.diff', deep: true, diffTests: true })).rejects.toThrow('exit 2');
        expect(exit).toHaveBeenCalledWith(2);
        expect(JSON.parse(out[0])).toEqual({ error: 'INPUT_ERROR', message: expect.stringContaining('--diff-tests needs a model') });
    });
});
