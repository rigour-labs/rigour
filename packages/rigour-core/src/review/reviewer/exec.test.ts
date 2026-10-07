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

    it('keeps a variable the command must not see out of its environment, and passes the rest through', async () => {
        process.env.RIGOUR_TEST_SECRET = 'gateway-key';
        process.env.RIGOUR_TEST_KEPT = 'kept';
        try {
            const print = ['-e', 'process.stdout.write(JSON.stringify({ secret: process.env.RIGOUR_TEST_SECRET ?? null, kept: process.env.RIGOUR_TEST_KEPT ?? null, added: process.env.RIGOUR_TEST_ADDED ?? null }))'];
            const hidden = await defaultExec(process.execPath, print, { cwd: os.tmpdir(), timeoutMs: 30_000, env: { RIGOUR_TEST_ADDED: 'added' }, unset: ['RIGOUR_TEST_SECRET'] });
            expect(JSON.parse(hidden.stdout)).toEqual({ secret: null, kept: 'kept', added: 'added' });
            const inherited = await defaultExec(process.execPath, print, { cwd: os.tmpdir(), timeoutMs: 30_000 });
            expect(JSON.parse(inherited.stdout)).toEqual({ secret: 'gateway-key', kept: 'kept', added: null });
        } finally {
            delete process.env.RIGOUR_TEST_SECRET;
            delete process.env.RIGOUR_TEST_KEPT;
        }
    });

    it('says why a command that never answered failed: not started, or timed out', async () => {
        const missing = await defaultExec('rigour-no-such-command', [], { cwd: os.tmpdir(), timeoutMs: 30_000 });
        expect(missing.exitCode).not.toBe(0);
        expect(missing.stderr).toContain('rigour-no-such-command'); // ENOENT on Unix, "is not recognized" on Windows
        const slow = await defaultExec(process.execPath, ['-e', 'setTimeout(() => {}, 10_000)'], { cwd: os.tmpdir(), timeoutMs: 200 });
        expect(slow.exitCode).not.toBe(0);
        expect(slow.stderr).toMatch(/timed out/i);
    });
});
