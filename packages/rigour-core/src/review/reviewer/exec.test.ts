import os from 'os';
import { describe, expect, it } from 'vitest';
import { defaultExec } from './exec.js';

describe('running a command', () => {
    it('passes the command\'s own output through', async () => {
        const result = await defaultExec(process.execPath, ['-e', 'process.stdout.write("out"); process.stderr.write("err"); process.exit(3)'], { cwd: os.tmpdir(), timeoutMs: 30_000 });
        expect(result).toEqual({ exitCode: 3, stdout: 'out', stderr: 'err' });
    });

    it('says why a command that never answered failed: not started, or timed out', async () => {
        const missing = await defaultExec('rigour-no-such-command', [], { cwd: os.tmpdir(), timeoutMs: 30_000 });
        expect(missing.exitCode).not.toBe(0);
        expect(missing.stderr).toMatch(/ENOENT/);
        const slow = await defaultExec(process.execPath, ['-e', 'setTimeout(() => {}, 10_000)'], { cwd: os.tmpdir(), timeoutMs: 200 });
        expect(slow.exitCode).not.toBe(0);
        expect(slow.stderr).toMatch(/timed out/i);
    });
});
