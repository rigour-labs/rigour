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
        expect(results.map(r => [r.tool, r.status])).toEqual([['format', 'skipped'], ['lint', 'skipped'], ['typecheck', 'skipped'], ['test', 'skipped']]);
    });

    it('fails, not skips, a tool the project declares but has not installed: a checkout without its dependencies proves nothing', async () => {
        fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ devDependencies: { eslint: '^9', typescript: '^5' } }));
        const results = await runToolchain(dir, ['src/a.ts'], config());
        expect(results.map(r => [r.tool, r.status])).toEqual([['format', 'skipped'], ['lint', 'fail'], ['typecheck', 'fail'], ['test', 'skipped']]);
        expect(results.find(r => r.tool === 'lint')).toMatchObject({ command: 'eslint is in package.json but not installed', output: expect.stringContaining('install the dependencies') });
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
