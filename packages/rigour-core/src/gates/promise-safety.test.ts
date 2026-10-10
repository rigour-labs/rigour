import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PromiseSafetyGate } from './promise-safety.js';

describe('PromiseSafetyGate unhandled .then', () => {
    let cwd: string;
    beforeEach(() => { cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'promise-safety-')); });
    afterEach(() => { fs.rmSync(cwd, { recursive: true, force: true }); });

    async function thenFindings(code: string): Promise<number> {
        fs.writeFileSync(path.join(cwd, 'session.ts'), code);
        const failures = await new PromiseSafetyGate().run({ cwd });
        return failures.filter(f => f.details.includes('unhandled-then')).length;
    }

    it('flags a .then chain with no .catch', async () => {
        expect(await thenFindings('export function wake(p: Promise<number>) {\n  p.then(n => {\n    if (n > 1) log(n);\n  });\n}\ndeclare function log(n: number): void;\n')).toBe(1);
    });

    it('finds the .catch that closes a chain whose callback body has if and return statements', async () => {
        const code = [
            'export function wake(accepted: Promise<{ action: string }>) {',
            '  void accepted',
            '    .then(result => {',
            "      if (result.action === 'wake') {",
            '        return run();',
            '      }',
            '      return undefined;',
            '    })',
            '    .catch(() => {});',
            '}',
            'declare function run(): Promise<void>;',
        ].join('\n');
        expect(await thenFindings(code)).toBe(0);
    });
});

describe('PromiseSafetyGate unsafe parse in tests', () => {
    let cwd: string;
    beforeEach(() => { cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'promise-safety-parse-')); });
    afterEach(() => { fs.rmSync(cwd, { recursive: true, force: true }); });

    const put = (rel: string, body: string) => {
        fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true });
        fs.writeFileSync(path.join(cwd, rel), body);
    };

    it('reports an unguarded parse in code, never in a test, where an uncaught parse error is the test failing', async () => {
        const parse = 'import json\n\ndef load(body):\n    return json.loads(body)\n';
        put('app/api.py', parse);
        put('tests/test_api.py', parse);
        put('app/conftest.py', parse);
        put('web/load.spec.ts', 'export const load = (s: string) => JSON.parse(s);\n');
        const failures = await new PromiseSafetyGate({ check_unsafe_parse: true }).run({ cwd });
        const parsed = failures.filter(f => f.details.includes('unsafe-parse')).map(f => f.files?.[0]);
        expect(parsed).toEqual(['app/api.py']);
    });
});
