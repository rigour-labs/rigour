import os from 'os';
import { describe, expect, it } from 'vitest';
import { defaultExec } from './exec.js';

describe('running a command', () => {
    it('passes the command\'s own output through', async () => {
        const result = await defaultExec(process.execPath, ['-e', 'process.stdout.write("out"); process.stderr.write("err"); process.exit(3)'], { cwd: os.tmpdir(), timeoutMs: 30_000 });
        expect(result).toEqual({ exitCode: 3, stdout: 'out', stderr: 'err' });
    });

    it('gives the command an ended stdin, so one that reads it never waits and one that exits at once never fails', async () => {
        const reader = await defaultExec(process.execPath, ['-e', 'let n = 0; process.stdin.on("data", d => n += d.length).on("end", () => process.stdout.write(`read ${n}`))'], { cwd: os.tmpdir(), timeoutMs: 30_000 });
        expect(reader).toEqual({ exitCode: 0, stdout: 'read 0', stderr: '' });
        const runs = await Promise.all(Array.from({ length: 50 }, () => defaultExec(process.execPath, ['-e', 'process.stdout.write("ok")'], { cwd: os.tmpdir(), timeoutMs: 30_000 })));
        expect(runs.every(r => r.exitCode === 0 && r.stdout === 'ok')).toBe(true);
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
