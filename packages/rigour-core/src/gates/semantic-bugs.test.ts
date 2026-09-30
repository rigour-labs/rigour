import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SemanticBugsGate } from './semantic-bugs.js';
import { GateRunner } from './runner.js';
import { ConfigSchema } from '../types/index.js';

const LEAKY = [
    'export async function notify(endpoint: string, signature: string) {',
    "  return fetch(endpoint, { method: 'POST', headers: { 'x-hook-signature': signature } });",
    '}',
].join('\n');

describe('SemanticBugsGate', () => {
    let cwd: string;
    beforeEach(() => { cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-gate-')); });
    afterEach(() => { fs.rmSync(cwd, { recursive: true, force: true }); });

    function write(rel: string, body: string) {
        fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true });
        fs.writeFileSync(path.join(cwd, rel), body);
    }

    it('runs an unvalidated candidate rule only when it is named', async () => {
        write('src/scroll.ts', "export function setup(fn: () => void) {\n  window.addEventListener('a', fn);\n  addEventListener('b', fn);\n}\n");
        expect(await new SemanticBugsGate().run({ cwd })).toEqual([]);
        const named = await new SemanticBugsGate({ rules: ['env/bare-browser-global'] }).run({ cwd });
        expect(named.map(f => [f.category, f.line])).toEqual([['env/bare-browser-global', 3]]);
    });

    it('reports a proven finding with its evidence, rule and verified metadata', async () => {
        write('src/notify.ts', LEAKY);
        const [failure, ...rest] = await new SemanticBugsGate().run({ cwd });
        expect(rest).toHaveLength(0);
        expect(failure).toMatchObject({
            id: 'semantic-bugs', files: ['src/notify.ts'], line: 2, severity: 'high',
            provenance: 'security', source: 'ast', category: 'credential-redirect', verified: true, confidence: 1,
        });
        expect(failure.title).toMatch(/^\[credential-redirect\]/);
        expect(failure.details).toContain('at src/notify.ts:2');
    });

    it('skips test files and declaration files', async () => {
        write('src/notify.test.ts', LEAKY);
        write('src/__tests__/notify.ts', LEAKY);
        write('types/notify.d.ts', 'export declare function notify(): void;\n');
        expect(await new SemanticBugsGate().run({ cwd })).toEqual([]);
    });

    it('honours a scoped run', async () => {
        write('src/notify.ts', LEAKY);
        write('src/other.ts', LEAKY);
        const failures = await new SemanticBugsGate().run({ cwd, patterns: ['src/other.ts'] });
        expect(failures.map(f => f.files?.[0])).toEqual(['src/other.ts']);
    });

    it('runs only the configured rules', async () => {
        write('src/notify.ts', LEAKY);
        expect(await new SemanticBugsGate({ rules: ['in-memory-aggregation'] }).run({ cwd })).toEqual([]);
    });

    it('runs learned rules from .rigour/rules next to the built-in ones', async () => {
        write('src/load.ts', "export const load = (url: string) => fetch(url, { method: 'GET' });\n");
        write('.rigour/rules/require-option-redirect-abcd1234.json', JSON.stringify({
            id: 'require-option-redirect-abcd1234', version: 1,
            pattern: { template: 'require-option', callee: { level: 'name', key: 'fetch' }, argIndex: 1, property: 'redirect' },
            message: 'fetch(...) does not set `redirect`.', severity: 'medium',
            source: { commit: 'abcdef0123', file: 'src/http.ts', function: 'post' },
            validation: { firesBefore: 1, firesAfter: 0, maxHits: 3, repoHits: [] },
        }));
        const [failure, ...rest] = await new SemanticBugsGate().run({ cwd });
        expect(rest).toHaveLength(0);
        expect(failure).toMatchObject({ files: ['src/load.ts'], line: 1, category: 'learned-rule', severity: 'medium' });
        expect(failure.title).toContain('[learned/require-option-redirect-abcd1234]');
        expect(failure.hint).toContain('fix abcdef01 in src/http.ts (post)');
    });

    it('is on by default and can be turned off in rigour.yml', async () => {
        write('src/notify.ts', LEAKY);
        const on = await new GateRunner(ConfigSchema.parse({ version: 1 })).run(cwd);
        expect(on.failures.some(f => f.id === 'semantic-bugs')).toBe(true);
        const off = await new GateRunner(ConfigSchema.parse({ version: 1, gates: { semantic_bugs: { enabled: false } } })).run(cwd);
        expect(off.failures.some(f => f.id === 'semantic-bugs')).toBe(false);
    });
});
