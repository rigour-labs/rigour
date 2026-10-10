/**
 * Tests for the hooks fast-checker module.
 * Verifies all 4 fast gates: file-size, hallucinated-imports, promise-safety, security-patterns.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runHookChecker } from './checker.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import yaml from 'yaml';

describe('runHookChecker', () => {
    let testDir: string;

    beforeEach(() => {
        testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-checker-test-'));
        // Write minimal rigour.yml
        fs.writeFileSync(path.join(testDir, 'rigour.yml'), yaml.stringify({
            version: 1,
            gates: { max_file_lines: 50 },
        }));
        // Write package.json for import resolution
        fs.writeFileSync(path.join(testDir, 'package.json'), JSON.stringify({
            name: 'test-proj',
            dependencies: { express: '^4.0.0' },
        }));
    });

    afterEach(() => {
        fs.rmSync(testDir, { recursive: true, force: true });
    });

    it('should return pass for clean files', async () => {
        const filePath = path.join(testDir, 'clean.ts');
        fs.writeFileSync(filePath, 'export const x = 1;\n');

        const result = await runHookChecker({ cwd: testDir, files: [filePath] });
        expect(result.status).toBe('pass');
        expect(result.failures).toHaveLength(0);
        expect(result.duration_ms).toBeGreaterThanOrEqual(0);
    });

    it('lets an agent edit CLAUDE.md by default, and blocks it only when the team opts in', async () => {
        const filePath = path.join(testDir, 'CLAUDE.md');
        fs.writeFileSync(filePath, '# Rules\n\n- Use the retry wrapper for partner APIs.\n');
        const byDefault = await runHookChecker({ cwd: testDir, files: [filePath] });
        expect(byDefault.failures.filter(f => f.gate === 'governance')).toEqual([]);

        fs.writeFileSync(path.join(testDir, 'rigour.yml'), yaml.stringify({ version: 1, gates: { governance: { enforce_memory: true } } }));
        const optedIn = await runHookChecker({ cwd: testDir, files: [filePath] });
        expect(optedIn.failures.some(f => f.gate === 'governance')).toBe(true);
    });

    it("refuses an agent edit to Rigour's own state, even when rigour.yml ignores .rigour/", async () => {
        fs.writeFileSync(path.join(testDir, 'rigour.yml'), 'version: 1\nignore:\n  - ".rigour/**"\n');
        fs.mkdirSync(path.join(testDir, '.rigour'), { recursive: true });
        fs.writeFileSync(path.join(testDir, '.rigour', 'dismissed.json'), '{"version":1,"entries":[]}');
        const result = await runHookChecker({ cwd: testDir, files: ['.rigour/dismissed.json'] });
        expect(result.status).toBe('fail');
        expect(result.failures[0]).toMatchObject({ gate: 'file-guard', severity: 'critical' });
    });

    it('catches a real vendor key whatever it is named, and leaves publishable and test keys alone', async () => {
        // Built at runtime: a key-shaped literal in this source would be (rightly) refused by secret scanning.
        const fake = (prefix: string) => `${prefix}_${'51HxQ'}${'abcdefghijklmnopqrstuv'}`;
        fs.writeFileSync(path.join(testDir, 'pay.ts'), `export const stripe = {\n  value: "${fake('sk_live')}",\n};\n`);
        fs.writeFileSync(path.join(testDir, 'public.ts'), `export const key = "${fake('pk_live')}";\nexport const t = "${fake('sk_test')}";\n`);
        const leaked = await runHookChecker({ cwd: testDir, files: ['pay.ts'] });
        expect(leaked.failures).toEqual([expect.objectContaining({ gate: 'security-patterns', line: 2, severity: 'critical', message: 'Stripe API key detected in code' })]);
        const fine = await runHookChecker({ cwd: testDir, files: ['public.ts'] });
        expect(fine.failures.filter(f => f.gate === 'security-patterns')).toEqual([]);
    });

    it('should detect file size violations', async () => {
        const filePath = path.join(testDir, 'big.ts');
        const lines = Array.from({ length: 100 }, (_, i) => `export const v${i} = ${i};`);
        fs.writeFileSync(filePath, lines.join('\n'));

        const result = await runHookChecker({ cwd: testDir, files: [filePath] });
        expect(result.status).toBe('fail');
        expect(result.failures.some(f => f.gate === 'file-size')).toBe(true);
    });

    it('should detect hardcoded secrets', async () => {
        const filePath = path.join(testDir, 'auth.ts');
        fs.writeFileSync(filePath, `
            const api_key = "abcdefghijklmnopqrstuvwxyz123456";
        `);

        const result = await runHookChecker({ cwd: testDir, files: [filePath] });
        expect(result.status).toBe('fail');
        expect(result.failures.some(f => f.gate === 'security-patterns')).toBe(true);
    });

    it('should detect command injection patterns', async () => {
        const filePath = path.join(testDir, 'cmd.ts');
        fs.writeFileSync(filePath, `
            import { exec } from 'child_process';
            exec(\`rm -rf \${userInput}\`);
        `);

        const result = await runHookChecker({ cwd: testDir, files: [filePath] });
        expect(result.status).toBe('fail');
        expect(result.failures.some(f =>
            f.gate === 'security-patterns' && f.message.includes('command injection')
        )).toBe(true);
    });

    it('should detect JSON.parse without try/catch', async () => {
        const filePath = path.join(testDir, 'parse.ts');
        fs.writeFileSync(filePath, `
            const data = JSON.parse(input);
            console.log(data);
        `);

        const result = await runHookChecker({ cwd: testDir, files: [filePath] });
        expect(result.status).toBe('fail');
        expect(result.failures.some(f => f.gate === 'promise-safety')).toBe(true);
    });

    it('should skip non-existent files gracefully', async () => {
        const result = await runHookChecker({
            cwd: testDir,
            files: ['/does/not/exist.ts'],
        });
        expect(result.status).toBe('pass');
        expect(result.failures).toHaveLength(0);
    });

    it('should handle multiple files', async () => {
        const cleanFile = path.join(testDir, 'clean.ts');
        fs.writeFileSync(cleanFile, 'export const x = 1;\n');

        const badFile = path.join(testDir, 'bad.ts');
        fs.writeFileSync(badFile, `const password = "supersecretpassword123456";`);

        const result = await runHookChecker({
            cwd: testDir,
            files: [cleanFile, badFile],
        });
        expect(result.status).toBe('fail');
        expect(result.failures.length).toBeGreaterThan(0);
    });

    it('should handle missing config gracefully', async () => {
        // Remove rigour.yml
        fs.unlinkSync(path.join(testDir, 'rigour.yml'));

        const filePath = path.join(testDir, 'test.ts');
        fs.writeFileSync(filePath, 'export const x = 1;\n');

        const result = await runHookChecker({ cwd: testDir, files: [filePath] });
        expect(result.status).toBe('pass');
    });

    it('should complete within timeout', async () => {
        const filePath = path.join(testDir, 'test.ts');
        fs.writeFileSync(filePath, 'export const x = 1;\n');

        const result = await runHookChecker({
            cwd: testDir,
            files: [filePath],
            timeout_ms: 5000,
        });
        expect(result.duration_ms).toBeLessThan(5000);
    });

    it('should detect hallucinated relative imports', async () => {
        const filePath = path.join(testDir, 'app.ts');
        fs.writeFileSync(filePath, `
            import { helper } from './nonexistent-module';
        `);

        const result = await runHookChecker({ cwd: testDir, files: [filePath] });
        expect(result.status).toBe('fail');
        expect(result.failures.some(f => f.gate === 'hallucinated-imports')).toBe(true);
    });

    it('resolves a TypeScript ESM import the way NodeNext and bundlers do: .js to .ts or .tsx, a folder to its index; a missing file still flags', async () => {
        fs.mkdirSync(path.join(testDir, 'src', 'lib'), { recursive: true });
        fs.writeFileSync(path.join(testDir, 'package.json'), '{"type":"module"}\n');
        fs.writeFileSync(path.join(testDir, 'src', 'b.ts'), 'export const b = 1;\n');
        fs.writeFileSync(path.join(testDir, 'src', 'view.tsx'), 'export const view = 1;\n');
        fs.writeFileSync(path.join(testDir, 'src', 'lib', 'index.ts'), 'export const lib = 1;\n');
        const filePath = path.join(testDir, 'src', 'a.ts');
        fs.writeFileSync(filePath, "import { b } from './b.js';\nimport { view } from './view.js';\nimport { lib } from './lib';\nimport { nope } from './nope.js';\n");
        const result = await runHookChecker({ cwd: testDir, files: [filePath] });
        expect(result.failures.filter(f => f.gate === 'hallucinated-imports').map(f => f.message)).toEqual(["Import './nope.js' does not resolve to an existing file"]);
    });

    it('reads an import written in a string or a comment as text, not an import', async () => {
        const filePath = path.join(testDir, 'templates.ts');
        fs.writeFileSync(filePath, [
            '/**',
            " * Gates import from here: `import { adapters } from './language-adapters/index.js'`",
            ' */',
            "export const hook = `const { run } = require('./node_modules/@rigour-labs/core/dist/hooks/checker.js');`;",
            "export const fixture = \"import { used } from './util';\";",
            "// import { gone } from './gone.js';",
            "import { real } from './missing.js';",
        ].join('\n'));
        const result = await runHookChecker({ cwd: testDir, files: [filePath] });
        expect(result.failures.filter(f => f.gate === 'hallucinated-imports').map(f => f.line)).toEqual([7]);
    });

    it('should not flag existing relative imports', async () => {
        const helperPath = path.join(testDir, 'helper.ts');
        fs.writeFileSync(helperPath, 'export const help = true;\n');

        const filePath = path.join(testDir, 'app.ts');
        fs.writeFileSync(filePath, `
            import { help } from './helper';
        `);

        const result = await runHookChecker({ cwd: testDir, files: [filePath] });
        const importFailures = result.failures.filter(f => f.gate === 'hallucinated-imports');
        expect(importFailures).toHaveLength(0);
    });
});

describe('runHookChecker on a file the repository already has', () => {
    let repo: string;
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
    const lines = (n: number, prefix = 'export const x') => Array.from({ length: n }, (_, i) => `${prefix}${i} = ${i};`).join('\n');
    const commit = (rel: string, body: string) => {
        fs.writeFileSync(path.join(repo, rel), body);
        git('add', '-A');
        git('commit', '-qm', rel);
    };
    const check = (rel: string, body: string) => {
        fs.writeFileSync(path.join(repo, rel), body);
        return runHookChecker({ cwd: repo, files: [path.join(repo, rel)] });
    };

    beforeEach(() => {
        repo = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-checker-git-'));
        git('init', '-q', '-b', 'main');
        git('config', 'user.email', 't@example.com');
        git('config', 'user.name', 't');
        git('config', 'commit.gpgsign', 'false');
        commit('rigour.yml', yaml.stringify({ version: 1, gates: { max_file_lines: 500 } }));
    });
    afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

    it('notes a file that was already over the limit and grew, without blocking', async () => {
        commit('big.ts', lines(600));
        const result = await check('big.ts', lines(610));
        expect(result.status).toBe('pass');
        expect(result.failures).toEqual([]);
        expect(result.notes).toEqual([expect.objectContaining({ gate: 'file-size', file: 'big.ts', message: expect.stringContaining('grew from 600 to 610 lines') })]);
    });

    it('blocks an edit that takes a file over the limit', async () => {
        commit('near.ts', lines(495));
        const result = await check('near.ts', lines(505));
        expect(result.status).toBe('fail');
        expect(result.failures).toEqual([expect.objectContaining({ gate: 'file-size', message: 'File has 505 lines (max: 500)' })]);
    });

    it('says nothing when a file over the limit shrinks', async () => {
        commit('big.ts', lines(600));
        const result = await check('big.ts', lines(590));
        expect(result.status).toBe('pass');
        expect(result.failures).toEqual([]);
        expect(result.notes).toBeUndefined();
    });

    it('blocks a new file over the limit', async () => {
        const result = await check('new.ts', lines(505));
        expect(result.failures.map(f => f.gate)).toEqual(['file-size']);
    });

    it('notes an import the file already had that resolves to nothing, and blocks one the edit adds', async () => {
        commit('a.ts', "import { gone } from './gone';\nexport const a = gone;\n");
        const kept = await check('a.ts', "import { gone } from './gone';\nexport const a = gone;\nexport const b = 2;\n");
        expect(kept.status).toBe('pass');
        expect(kept.notes?.map(f => f.gate)).toEqual(['hallucinated-imports']);
        const added = await check('a.ts', "import { gone } from './gone';\nimport { lost } from './lost';\nexport const a = gone ?? lost;\n");
        expect(added.status).toBe('fail');
        expect(added.failures.map(f => f.message)).toEqual([expect.stringContaining("'./lost'")]);
    });
});
