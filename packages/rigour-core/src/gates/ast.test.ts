import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ASTGate } from './ast.js';

describe('ASTGate ignore behavior', () => {
    let testDir: string;

    beforeEach(() => {
        testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ast-gate-test-'));
    });

    afterEach(() => {
        fs.rmSync(testDir, { recursive: true, force: true });
    });

    it('keeps default ignores when context.ignore is an empty array', async () => {
        const gate = new ASTGate({
            ast: { max_params: 1 },
        } as any);

        fs.mkdirSync(path.join(testDir, 'node_modules', 'example'), { recursive: true });
        fs.writeFileSync(
            path.join(testDir, 'node_modules', 'example', 'bad.js'),
            'function fromDeps(a, b, c) { return a + b + c; }',
            'utf-8'
        );

        fs.mkdirSync(path.join(testDir, 'src'), { recursive: true });
        fs.writeFileSync(path.join(testDir, 'src', 'ok.js'), 'function ok(a) { return a; }', 'utf-8');

        const failures = await gate.run({
            cwd: testDir,
            ignore: [],
        });

        expect(failures).toHaveLength(0);
    });

    it('merges user ignore patterns with default ignores', async () => {
        const gate = new ASTGate({
            ast: { max_params: 1 },
        } as any);

        fs.mkdirSync(path.join(testDir, 'generated'), { recursive: true });
        fs.writeFileSync(
            path.join(testDir, 'generated', 'bad.js'),
            'function generated(a, b, c) { return a + b + c; }',
            'utf-8'
        );

        fs.mkdirSync(path.join(testDir, 'src'), { recursive: true });
        fs.writeFileSync(path.join(testDir, 'src', 'ok.js'), 'function ok(a) { return a; }', 'utf-8');

        const failures = await gate.run({
            cwd: testDir,
            ignore: ['generated/**'],
        });

        expect(failures).toHaveLength(0);
    });

    it('ignores generated studio-dist assets by default', async () => {
        const gate = new ASTGate({
            ast: { max_params: 1 },
        } as any);

        fs.mkdirSync(path.join(testDir, 'packages', 'rigour-cli', 'studio-dist', 'assets'), { recursive: true });
        fs.writeFileSync(
            path.join(testDir, 'packages', 'rigour-cli', 'studio-dist', 'assets', 'index.js'),
            'function fromBundle(a, b, c) { return a + b + c; }',
            'utf-8'
        );

        const failures = await gate.run({
            cwd: testDir,
            ignore: [],
        });

        expect(failures).toHaveLength(0);
    });

    it('ignores examples directory by default', async () => {
        const gate = new ASTGate({
            ast: { max_params: 1 },
        } as any);

        fs.mkdirSync(path.join(testDir, 'examples', 'demo', 'src'), { recursive: true });
        fs.writeFileSync(
            path.join(testDir, 'examples', 'demo', 'src', 'bad.js'),
            'function noisy(a, b, c) { return a + b + c; }',
            'utf-8'
        );

        const failures = await gate.run({
            cwd: testDir,
            ignore: [],
        });

        expect(failures).toHaveLength(0);
    });

    it('sets severity and provenance on AST violations', async () => {
        const gate = new ASTGate({
            ast: { max_params: 1 },
        } as any);

        fs.mkdirSync(path.join(testDir, 'src'), { recursive: true });
        fs.writeFileSync(
            path.join(testDir, 'src', 'bad.js'),
            'function tooMany(a, b, c) { return a + b + c; }',
            'utf-8'
        );

        const failures = await gate.run({ cwd: testDir, ignore: [] });
        const target = failures.find((failure) => failure.id === 'AST_MAX_PARAMS');

        expect(target).toBeDefined();
        expect(target?.severity).toBe('medium');
        expect(target?.provenance).toBe('traditional');
    });

    it('marks prototype pollution findings as security-critical', async () => {
        const gate = new ASTGate({
            ast: { max_params: 10 },
        } as any);

        fs.mkdirSync(path.join(testDir, 'src'), { recursive: true });
        fs.writeFileSync(
            path.join(testDir, 'src', 'pollute.js'),
            'const target = {}; target.__proto__ = {};',
            'utf-8'
        );

        const failures = await gate.run({ cwd: testDir, ignore: [] });
        const target = failures.find((failure) => failure.id === 'SECURITY_PROTOTYPE_POLLUTION');

        expect(target).toBeDefined();
        expect(target?.severity).toBe('critical');
        expect(target?.provenance).toBe('security');
    });

    it('does not attribute nested function complexity to parent function', async () => {
        const gate = new ASTGate({
            ast: { complexity: 3, max_params: 10 },
        } as any);

        fs.mkdirSync(path.join(testDir, 'src'), { recursive: true });
        fs.writeFileSync(
            path.join(testDir, 'src', 'nested.ts'),
            `
            function outer(flag: boolean) {
              function inner(x: number) {
                if (x > 0) { return 1; }
                if (x < 0) { return -1; }
                if (x === 0) { return 0; }
                return 0;
              }
              return flag ? inner(1) : inner(-1);
            }
            `,
            'utf-8'
        );

        const failures = await gate.run({ cwd: testDir, ignore: [] });
        const complexityTitles = failures
            .filter((failure) => failure.id === 'AST_COMPLEXITY')
            .map((failure) => failure.title);

        expect(complexityTitles.some((title) => title.includes("'outer'"))).toBe(false);
    });
});
