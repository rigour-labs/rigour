import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixScope = vi.fn();
vi.mock('@rigour-labs/core', async original => ({ ...(await original<typeof import('@rigour-labs/core')>()), fixScope }));
const { printScope } = await import('./review-scope.js');

let dir: string;
let out: string[];
const SCOPE = { pr: 42, review: { id: 4, login: 'senior', submittedAt: '2026-10-03', commit: 'abcdef0123456789' }, cited: ['src/job.ts'], changed: ['src/job.ts', 'src/other.ts'], extra: ['src/other.ts'] };

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rigour-scope-'));
    out = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => void out.push(args.join(' ')));
    fixScope.mockReset();
});
afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
});

describe('rigour review --scope', () => {
    it('names the files no point cited and fails', async () => {
        fixScope.mockResolvedValue({ scope: SCOPE });
        expect(await printScope(dir, { scope: '42', scopeReview: '4' })).toBe(1);
        expect(fixScope).toHaveBeenCalledWith(dir, expect.objectContaining({ pr: 42, review: 4 }));
        const text = out.join('\n');
        expect(text).toContain("Fix round since senior's review of abcdef012 (pull request 42): 2 files changed, 1 file cited.");
        expect(text).toContain('✘ 1 file no point of the review cited');
        expect(text).toContain('  src/other.ts');
    });

    it('passes when the round stayed in scope, and answers in JSON', async () => {
        fixScope.mockResolvedValue({ scope: { ...SCOPE, extra: [] } });
        expect(await printScope(dir, { scope: true, json: true })).toBe(0);
        expect(fixScope).toHaveBeenCalledWith(dir, expect.objectContaining({ pr: undefined, review: undefined }));
        expect(JSON.parse(out.join('\n'))).toMatchObject({ status: 'PASS', pr: 42, extra: [] });
    });

    it('is not a pass when it could not tell, and refuses a pull request that is not a number', async () => {
        fixScope.mockResolvedValue({ error: 'pull request 42 has no review by a person yet' });
        expect(await printScope(dir, { scope: true })).toBe(3);
        expect(out.join('\n')).toContain("⚠ Could not check the fix round's scope: pull request 42 has no review by a person yet");
        await expect(printScope(dir, { scope: 'feature' })).rejects.toThrow('--scope takes a number, not "feature"');
    });
});
