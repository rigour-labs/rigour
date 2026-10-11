import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const npm = vi.hoisted(() => ({ calls: [] as Array<{ args: string[]; env?: Record<string, string> }>, installed: false }));
vi.mock('execa', () => ({
    execa: vi.fn(async (_file: string, args: string[], options: { env?: Record<string, string> }) => {
        npm.calls.push({ args, env: options.env });
        if (args[0] === 'install') npm.installed = true;
        return { exitCode: 0, stdout: '', stderr: '' };
    }),
}));
vi.mock('@rigour-labs/core', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@rigour-labs/core')>();
    return { ...actual, locateTransformers: () => (npm.installed ? path.join(actual.semanticRuntimeDir(), 'node_modules', 'x.js') : undefined) };
});

const prompt = vi.hoisted(() => ({ answer: true, asked: [] as string[] }));
vi.mock('@inquirer/prompts', () => ({ confirm: vi.fn(async ({ message }: { message: string }) => { prompt.asked.push(message); return prompt.answer; }) }));

import { semanticRuntimeDir, TRANSFORMERS_SPEC } from '@rigour-labs/core';
import { setupSemantic } from './semantic.js';

let home: string;
const original = process.env.RIGOUR_HOME;
beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-setup-'));
    process.env.RIGOUR_HOME = home;
    npm.calls = [];
    npm.installed = false;
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => {
    process.env.RIGOUR_HOME = original;
    fs.rmSync(home, { recursive: true, force: true });
    vi.restoreAllMocks();
});

describe('rigour setup, semantic search', () => {
    it('installs the library without the ONNX runtime\'s GPU download, and keeps only this platform\'s runtime', async () => {
        // What npm would leave behind: the runtime for every platform.
        const bin = path.join(semanticRuntimeDir(), 'node_modules', 'onnxruntime-node', 'bin', 'napi-v6');
        for (const where of [`${process.platform}/${process.arch}`, 'win32/arm64', 'freebsd/x64']) {
            fs.mkdirSync(path.join(bin, where), { recursive: true });
            fs.writeFileSync(path.join(bin, where, 'runtime.bin'), 'x');
        }
        await setupSemantic(home);
        expect(npm.calls).toEqual([{ args: ['install', '--no-audit', '--no-fund', '--omit=dev', TRANSFORMERS_SPEC], env: { ONNXRUNTIME_NODE_INSTALL: 'skip' } }]);
        expect(fs.readdirSync(bin)).toEqual([process.platform]);
        expect(fs.readdirSync(path.join(bin, process.platform))).toEqual([process.arch]);
    });

    it('removes the library an earlier setup installed, once the new one is in', async () => {
        const old = path.join(semanticRuntimeDir(), 'node_modules', '@xenova', 'transformers');
        fs.mkdirSync(old, { recursive: true });
        fs.writeFileSync(path.join(old, 'package.json'), '{}');
        await setupSemantic(home);
        expect(npm.calls.map(c => c.args.slice(0, 1).concat(c.args.slice(-1)))).toEqual([['install', TRANSFORMERS_SPEC], ['uninstall', '@xenova/transformers']]);
    });
});

describe('rigour setup, semantic search, at a terminal', () => {
    const tty = (on: boolean) => {
        for (const stream of [process.stdin, process.stdout]) Object.defineProperty(stream, 'isTTY', { value: on, configurable: true });
        vi.stubEnv('CI', '');
    };
    afterEach(() => {
        tty(false);
        vi.unstubAllEnvs();
        prompt.asked = [];
        prompt.answer = true;
    });

    it('asks first, with the size, and installs nothing when the person says no', async () => {
        tty(true);
        prompt.answer = false;
        await setupSemantic(home);
        expect(prompt.asked).toEqual([expect.stringContaining('about 250 MB on Linux, 280 MB on macOS')]);
        expect(npm.calls).toEqual([]);
    });

    it('installs when the person says yes, the default', async () => {
        tty(true);
        await setupSemantic(home);
        expect(prompt.asked).toHaveLength(1);
        expect(npm.calls.map(c => c.args[0])).toEqual(['install']);
    });

    it('never asks a script, a pipe or CI: it installs as before', async () => {
        tty(false);
        await setupSemantic(home);
        expect(prompt.asked).toEqual([]);
        expect(npm.calls.map(c => c.args[0])).toEqual(['install']);
        tty(true);
        vi.stubEnv('CI', 'true');
        npm.calls = [];
        npm.installed = false;
        await setupSemantic(home);
        expect(prompt.asked).toEqual([]);
    });
});
