import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { outcomesCommand } from './outcomes.js';

let repo: string;
const saved = { RIGOUR_OUTCOMES: process.env.RIGOUR_OUTCOMES };
beforeEach(() => {
    delete process.env.RIGOUR_OUTCOMES;
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'outcomes-cli-'));
    execFileSync('git', ['-C', repo, 'init', '-q', '-b', 'main']);
});
afterEach(() => {
    if (saved.RIGOUR_OUTCOMES === undefined) delete process.env.RIGOUR_OUTCOMES; else process.env.RIGOUR_OUTCOMES = saved.RIGOUR_OUTCOMES;
    fs.rmSync(repo, { recursive: true, force: true });
    vi.restoreAllMocks();
});

describe('rigour outcomes', () => {
    it('exits 0 with the reason when the outcome loop is off, so a CI step stays green', async () => {
        const out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        expect(await outcomesCommand(repo, { outcomes: false })).toBe(0);
        expect(out.mock.calls.flat().join('\n')).toContain('Nothing read (flag): the outcome loop is off');
        out.mockClear();
        expect(await outcomesCommand(repo, { json: true })).toBe(0);
        expect(JSON.parse(String(out.mock.calls[0][0]))).toMatchObject({ switch: { enabled: false }, read: 0 });
    });
});
