import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DiscoveryService } from './discovery.js';
import { containsToken, detectParadigm, stripComments } from './discovery-signals.js';

describe('DiscoveryService', () => {
    let cwd: string;
    beforeEach(() => { cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'discovery-')); });
    afterEach(() => { fs.rmSync(cwd, { recursive: true, force: true }); });

    function write(rel: string, body: string) {
        fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true });
        fs.writeFileSync(path.join(cwd, rel), body);
    }
    const discover = () => new DiscoveryService().discover(cwd);

    it('detects an API from a declared dependency', async () => {
        write('package.json', JSON.stringify({ dependencies: { express: '^4.0.0' } }));
        const result = await discover();
        expect(result.matches.preset).toEqual({ name: 'api', marker: 'dependency:express' });
    });

    it('detects a scoped framework package such as @nestjs/core', async () => {
        write('package.json', JSON.stringify({ dependencies: { '@nestjs/core': '^10.0.0' } }));
        expect((await discover()).matches.preset?.marker).toBe('dependency:nestjs');
    });

    it('detects a Python API with its ignore patterns', async () => {
        write('requirements.txt', 'flask==2.0.0\n');
        const result = await discover();
        expect(result.matches.preset?.name).toBe('api');
        expect(result.config.ignore).toEqual(expect.arrayContaining(['venv/**', '__pycache__/**', '*.pyc']));
    });

    it('detects a UI project from a config file with its ignore patterns', async () => {
        write('next.config.js', 'module.exports = {};\n');
        const result = await discover();
        expect(result.matches.preset?.name).toBe('ui');
        expect(result.config.ignore).toEqual(expect.arrayContaining(['node_modules/**', '.next/**']));
    });

    it('detects Svelte from its dependencies, not "reactivity" or "public" in comments', async () => {
        write('package.json', JSON.stringify({ devDependencies: { '@sveltejs/kit': '^2.0.0', svelte: '^5.0.0' } }));
        write('eslint.config.js', '// Svelte 5 rules (state_referenced_locally, a11y, reactivity)\nexport default [];\n');
        write('playwright.config.ts', '// rides the public internet\nexport default {};\n');
        write('src/lib/format.ts', 'export function format(v: number) { return v.toFixed(2); }\nexport const pad = (s: string) => s.padStart(2);\n');
        const result = await discover();
        expect(result.matches.preset).toEqual({ name: 'ui', marker: 'dependency:svelte' });
        expect(result.matches.paradigm?.name).toBe('functional');
    });

    it('does not read a framework name in source text as a dependency', async () => {
        write('src/middleware.ts', 'export function run(next: () => void) { next(); }\n');
        expect((await discover()).matches.preset).toBeUndefined();
    });

    it('identifies OOP from class declarations in a subfolder', async () => {
        write('src/Service.ts', 'export class MyService {}\nexport class OtherService {}\n');
        const result = await discover();
        expect(result.matches.paradigm).toEqual({ name: 'oop', marker: 'declarations: 2 classes, 0 functions' });
    });

    it('needs several recurring domain keywords before choosing a domain preset', async () => {
        write('src/billing.ts', 'export const ledger = new Map<string, number>();\n');
        write('src/report.ts', "import { ledger } from './billing';\nexport const total = () => ledger.size;\n");
        expect((await discover()).matches.preset).toBeUndefined();
        write('src/pay.ts', 'export function payment(ledger: Map<string, number>) { return ledger; }\n');
        write('src/refund.ts', 'export function refund(payment: number) { return -payment; }\n');
        expect((await discover()).matches.preset).toEqual({ name: 'fintech', marker: 'content:payment,ledger' });
    });

    it('needs a file marker to exist, not to be mentioned', async () => {
        write('src/serve.ts', "export const page = () => 'index.html';\n");
        expect((await discover()).matches.preset).toBeUndefined();
    });

    it('detects notebooks by file, not by the word ipynb in code', async () => {
        write('src/scan.ts', "export const exts = ['.ipynb', '.py'];\n");
        expect((await discover()).matches.preset).toBeUndefined();
        write('notebooks/explore.ipynb', '{}');
        expect((await discover()).matches.preset).toEqual({ name: 'data', marker: 'file:*.ipynb' });
    });

    it('leaves the paradigm unset for an empty project', async () => {
        expect((await discover()).matches.paradigm).toBeUndefined();
    });
});

describe('discovery signals', () => {
    it('matches whole tokens only', () => {
        expect(containsToken('import x from "react"', 'react')).toBe(true);
        expect(containsToken('reactivity', 'react')).toBe(false);
        expect(containsToken('@vue/compiler', 'vue')).toBe(false);
        expect(containsToken('GET /health', 'health')).toBe(false);
    });

    it('drops comments but keeps URLs in strings', () => {
        const text = stripComments('/* public */\nconst u = "https://x.io"; // public\n# public\n');
        expect(text).not.toContain('public');
        expect(text).toContain('https://x.io');
    });

    it('declines to guess a paradigm when neither side clearly leads', () => {
        expect(detectParadigm(['export class A {}\nexport function f() {}\n'])).toBeNull();
        expect(detectParadigm(['export class A {}\nexport function f() {}\nexport function g() {}\n'])?.name).toBe('functional');
    });
});
