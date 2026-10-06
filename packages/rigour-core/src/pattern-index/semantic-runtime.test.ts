import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { locateTransformers, semanticRuntimeDir, semanticRuntimeInstalled } from './semantic-runtime.js';

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

describe('the semantic runtime', () => {
    it('lives in Rigour\'s home, shared by every Rigour version, and is seen there once installed', () => {
        expect(semanticRuntimeDir()).toBe(path.join(home, '.rigour', 'runtime', 'semantic'));
        expect(semanticRuntimeInstalled()).toBe(false);
        const pkg = path.join(semanticRuntimeDir(), 'node_modules', '@xenova', 'transformers');
        fs.mkdirSync(pkg, { recursive: true });
        fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@xenova/transformers', main: 'index.js' }));
        fs.writeFileSync(path.join(pkg, 'index.js'), 'module.exports = {};');
        expect(semanticRuntimeInstalled()).toBe(true);
        expect(locateTransformers(home)).toBeDefined();
    });

    it('is not a dependency of the published package: the 240 MB is installed once, never per version', () => {
        const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8'));
        expect({ ...manifest.dependencies, ...manifest.optionalDependencies }).not.toHaveProperty('@xenova/transformers');
    });
});
