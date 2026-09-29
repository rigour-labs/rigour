import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installBinFolder, llamaBinaryName, probeBinary, resetProbeCache } from './llama-engine.js';

const isWindows = process.platform === 'win32';

async function writeScript(file: string, body: string): Promise<void> {
    await fs.outputFile(file, `#!/bin/sh\n${body}\n`);
    await fs.chmod(file, 0o755);
}

describe.skipIf(isWindows)('probeBinary', () => {
    let dir: string;
    beforeEach(async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigour-engine-'));
        resetProbeCache();
    });
    afterEach(async () => { await fs.remove(dir); });

    it('accepts a binary that reports its version', async () => {
        const bin = path.join(dir, 'llama-cli');
        await writeScript(bin, 'echo "version: 5604 (228f34c9)" >&2; exit 0');
        expect(await probeBinary(bin)).toEqual({ ok: true, version: '5604' });
    });

    it('rejects the placeholder brain script', async () => {
        const bin = path.join(dir, 'rigour-brain');
        await writeScript(bin, 'echo "rigour-brain is a placeholder." >&2; exit 1');
        const result = await probeBinary(bin);
        expect(result.ok).toBe(false);
        expect(result.error).toContain('placeholder');
    });

    it('rejects a missing binary', async () => {
        expect((await probeBinary(path.join(dir, 'nope'))).ok).toBe(false);
    });
});

describe('installBinFolder', () => {
    let dir: string;
    beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigour-engine-')); });
    afterEach(async () => { await fs.remove(dir); });

    it('installs the binary together with the shared libraries next to it', async () => {
        const extracted = path.join(dir, 'extract', 'build', 'bin');
        await fs.outputFile(path.join(extracted, llamaBinaryName()), 'bin');
        await fs.outputFile(path.join(extracted, 'libllama.dylib'), 'lib');
        await fs.outputFile(path.join(extracted, 'ggml-metal.metal'), 'metal');
        const installDir = path.join(dir, 'llama-b5604');

        await installBinFolder(path.join(dir, 'extract'), installDir);

        expect((await fs.readdir(installDir)).sort()).toEqual(['ggml-metal.metal', 'libllama.dylib', llamaBinaryName()].sort());
    });

    it('fails clearly when the archive has no llama-cli', async () => {
        await fs.outputFile(path.join(dir, 'extract', 'README.md'), 'x');
        await expect(installBinFolder(path.join(dir, 'extract'), path.join(dir, 'out'))).rejects.toThrow('not found');
    });
});
