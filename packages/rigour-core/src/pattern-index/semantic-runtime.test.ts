import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { locateTransformers, pruneSemanticRuntime, retiredSemanticRuntimeInstalled, semanticRuntimeDir, semanticRuntimeInstalled } from './semantic-runtime.js';

let home: string;
const original = process.env.RIGOUR_HOME;
beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-home-'));
    process.env.RIGOUR_HOME = home;
});
afterEach(() => {
    process.env.RIGOUR_HOME = original;
    fs.rmSync(home, { recursive: true, force: true });
});

/** A stand-in for a library npm installed into Rigour's home. */
function install(name: string) {
    const pkg = path.join(semanticRuntimeDir(), 'node_modules', ...name.split('/'));
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name, main: 'index.js' }));
    fs.writeFileSync(path.join(pkg, 'index.js'), 'module.exports = {};');
}

describe('the semantic runtime', () => {
    it('lives in Rigour\'s home, shared by every Rigour version, and is seen there once installed', () => {
        expect(semanticRuntimeDir()).toBe(path.join(home, '.rigour', 'runtime', 'semantic'));
        expect(semanticRuntimeInstalled()).toBe(false);
        install('@xenova/transformers');
        expect(semanticRuntimeInstalled()).toBe(false); // what setup installed up to 6.x is never loaded
        expect(retiredSemanticRuntimeInstalled()).toBe(true);
        install('@huggingface/transformers');
        expect(semanticRuntimeInstalled()).toBe(true);
        expect(locateTransformers(home)).toBeDefined();
    });

    it('keeps only the ONNX runtime binaries for this platform and architecture', () => {
        const bin = path.join(home, 'node_modules', 'onnxruntime-node', 'bin', 'napi-v6');
        for (const where of ['linux/x64', 'linux/arm64', 'darwin/arm64', 'win32/x64']) {
            fs.mkdirSync(path.join(bin, where), { recursive: true });
            fs.writeFileSync(path.join(bin, where, 'libonnxruntime.bin'), 'x'.repeat(100));
        }
        expect(pruneSemanticRuntime(home, 'linux', 'x64')).toBe(300);
        expect(fs.readdirSync(bin)).toEqual(['linux']);
        expect(fs.readdirSync(path.join(bin, 'linux'))).toEqual(['x64']);
        expect(pruneSemanticRuntime(home, 'linux', 'x64')).toBe(0); // a second run finds nothing to remove
    });

    it('is not a dependency of the published package: it is installed once, never per version', () => {
        const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8'));
        expect({ ...manifest.dependencies, ...manifest.optionalDependencies }).not.toHaveProperty('@huggingface/transformers');
        expect({ ...manifest.dependencies, ...manifest.optionalDependencies }).not.toHaveProperty('@xenova/transformers');
    });
});
