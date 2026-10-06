import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigSchema } from '../types/index.js';
import { runToolchain } from './toolchain.js';

let dir: string;
const config = (commands: Record<string, string> = {}) => ConfigSchema.parse({ version: 1, commands });

/** A fake installed tool: node logic plus the sh and .cmd shims npm would create. */
function tool(name: string, logic: string): void {
    const bin = path.join(dir, 'node_modules', '.bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, `${name}.js`), `const fs = require('fs'); const args = process.argv.slice(2);\nfs.appendFileSync(${JSON.stringify(path.join(dir, 'calls.log'))}, ${JSON.stringify(name)} + ' ' + args.join(' ') + '\\n');\n${logic}\n`);
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\nexec node "$(dirname "$0")/${name}.js" "$@"\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, `${name}.cmd`), `@node "%~dp0\\${name}.js" %*\r\n`);
}
const calls = () => (fs.existsSync(path.join(dir, 'calls.log')) ? fs.readFileSync(path.join(dir, 'calls.log'), 'utf8') : '');

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'toolchain-'));
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src/a.ts'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(dir, 'src/bad.ts'), 'BAD\n');
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('runToolchain', () => {
    it('reports every tool the project did not install as skipped, never downloading one', async () => {
        const results = await runToolchain(dir, ['src/a.ts'], config());
        expect(results.map(r => [r.tool, r.status])).toEqual([['format', 'skipped'], ['lint', 'skipped'], ['overlay', 'skipped'], ['typecheck', 'skipped'], ['test', 'skipped'], ['knip', 'skipped']]);
    });

    it('fails, not skips, a tool the project declares but has not installed: a checkout without its dependencies proves nothing', async () => {
        fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ devDependencies: { eslint: '^9', typescript: '^5' } }));
        const results = await runToolchain(dir, ['src/a.ts'], config());
        expect(results.map(r => [r.tool, r.status])).toEqual([['format', 'skipped'], ['lint', 'fail'], ['overlay', 'skipped'], ['typecheck', 'fail'], ['test', 'skipped'], ['knip', 'skipped']]);
        expect(results.find(r => r.tool === 'lint')).toMatchObject({ command: 'eslint is in package.json but not installed', output: expect.stringContaining('install the dependencies') });
    });

    it('runs type-checked rules the project does not enable, blocking on changed lines only, with the project\'s own eslint and config', async () => {
        fs.writeFileSync(path.join(dir, 'eslint.config.js'), 'export default [];\n');
        fs.mkdirSync(path.join(dir, 'node_modules/typescript-eslint'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'node_modules/typescript-eslint/package.json'), '{"name":"typescript-eslint","main":"index.js"}');
        fs.writeFileSync(path.join(dir, 'node_modules/typescript-eslint/index.js'), 'module.exports = {};');
        const report = JSON.stringify([{ filePath: path.join(dir, 'src/a.ts'), messages: [
            { line: 2, column: 5, ruleId: '@typescript-eslint/no-unnecessary-condition', message: 'Unnecessary conditional, value is always truthy.' },
            { line: 9, column: 1, ruleId: '@typescript-eslint/no-floating-promises', message: 'Promises must be awaited.' },
        ] }]);
        tool('eslint', `if (args[0] === '--version') { console.log('v9.0.0'); process.exit(0); }\nif (args.includes('--format')) { console.log(${JSON.stringify(report)}); process.exit(1); }\nprocess.exit(0);`);
        const results = await runToolchain(dir, ['src/a.ts'], config(), { 'src/a.ts': new Set([1, 2, 3]) });
        const overlay = results.find(r => r.tool === 'overlay')!;
        expect(overlay).toMatchObject({ status: 'fail', lines: ['src/a.ts:2:5 @typescript-eslint/no-unnecessary-condition: Unnecessary conditional, value is always truthy.'] });
        expect(overlay.command).toContain('1 on changed lines, 1 pre-existing (not blocking)');
        const call = calls().split('\n').find(line => line.includes('--format json'))!;
        expect(call).toMatch(/eslint --config \S+eslint\.overlay\.config\.mjs --no-warn-ignored --format json src\/a\.ts/);
        expect(fs.readdirSync(dir)).not.toContain('eslint.overlay.config.mjs'); // never written into the repository
        // Nothing on a changed line: pass, backlog counted.
        const clean = await runToolchain(dir, ['src/a.ts'], config(), { 'src/a.ts': new Set([7]) });
        expect(clean.find(r => r.tool === 'overlay')).toMatchObject({ status: 'pass', command: expect.stringContaining('0 on changed lines, 2 pre-existing') });
    });

    it('runs knip when the project installs it, and reports only what is in the changed files', async () => {
        const report = JSON.stringify({ files: [path.join(dir, 'src/dead.ts'), 'src/elsewhere.ts'], issues: [
            { file: 'src/a.ts', exports: [{ name: 'spare', line: 3, col: 1 }], types: [{ name: 'Spare', line: 4, col: 1 }] },
            { file: 'src/other.ts', exports: [{ name: 'old', line: 1, col: 1 }], types: [] },
        ] });
        tool('knip', `console.log(${JSON.stringify(report)}); process.exit(1);`);
        fs.writeFileSync(path.join(dir, 'src/dead.ts'), 'export const dead = 1;\n');
        const results = await runToolchain(dir, ['src/a.ts', 'src/dead.ts'], config());
        expect(results.find(r => r.tool === 'knip')).toMatchObject({ status: 'fail', lines: ['src/dead.ts: nothing imports or runs this file', 'src/a.ts:3: unused export spare', 'src/a.ts:4: unused export Spare'] });
        expect(calls()).toContain('knip --production --no-progress --reporter json');
    });

    it('runs the formatter on changed files only and reports what it said', async () => {
        tool('prettier', "const bad = args.filter(a => a.endsWith('.ts') && fs.readFileSync(a, 'utf8').includes('BAD'));\nif (bad.length) { console.log('[warn] ' + bad.join(' ')); process.exit(1); }");
        const [format] = await runToolchain(dir, ['src/a.ts', 'src/bad.ts', 'src/gone.ts'], config());
        expect(format).toMatchObject({ tool: 'format', status: 'fail' });
        expect(format.output).toContain('src/bad.ts');
        expect(calls()).toContain('prettier --check --ignore-unknown src/a.ts src/bad.ts');
        expect(calls()).not.toContain('gone.ts');
    });

    it('quiets ESLint 9 about ignored files, and leaves a tool set under commands: to that command', async () => {
        tool('eslint', "if (args[0] === '--version') { console.log('v9.1.0'); process.exit(0); }");
        const results = await runToolchain(dir, ['src/a.ts'], config({ format: 'npm run fmt' }));
        expect(results.find(r => r.tool === 'lint')).toMatchObject({ status: 'pass' });
        expect(calls()).toContain('eslint --max-warnings=0 --no-warn-ignored src/a.ts');
        expect(results.find(r => r.tool === 'format')).toMatchObject({ status: 'skipped', command: 'commands.format runs it' });
    });

    it("uses the project's own check script for types, and never hands a tool Rigour's own files", async () => {
        fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { check: 'node -e "process.exit(3)"' } }));
        tool('prettier', 'process.exit(0);');
        const results = await runToolchain(dir, ['src/a.ts', '.rigour/scan-cache.json', 'rigour-report.json'], config());
        expect(results.find(r => r.tool === 'typecheck')).toMatchObject({ status: 'fail', command: expect.stringContaining('npm') });
        expect(calls()).toContain('prettier --check --ignore-unknown src/a.ts\n');
    });

    it('finds svelte-check by its binary, generating SvelteKit types first, with no svelte.config file', async () => {
        tool('svelte-kit', 'process.exit(0);');
        tool('svelte-check', 'process.exit(0);');
        fs.writeFileSync(path.join(dir, 'tsconfig.json'), '{}');
        const typecheck = (await runToolchain(dir, ['src/a.ts'], config())).find(r => r.tool === 'typecheck')!;
        expect(typecheck).toMatchObject({ status: 'pass', command: expect.stringContaining('svelte-check') });
        expect(calls().indexOf('svelte-kit sync')).toBeLessThan(calls().indexOf('svelte-check'));
    });

    it('runs a test file that failed in the parallel run again alone, so a timing flake passes', async () => {
        tool('vitest', "if (args[0] === 'related') { console.log(' FAIL  src/a.test.ts > flaky'); process.exit(1); }\nprocess.exit(0);");
        const test = (await runToolchain(dir, ['src/a.ts'], config())).find(r => r.tool === 'test')!;
        expect(test.status).toBe('pass');
        expect(test.command).toContain('flaky files passed alone: src/a.test.ts');
        expect(calls()).toContain('vitest run src/a.test.ts');
    });
});
