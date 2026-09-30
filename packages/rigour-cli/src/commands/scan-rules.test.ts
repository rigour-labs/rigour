import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { scanRulesCommand } from './scan-rules.js';

describe('rigour scan-rules', () => {
    let dir: string | undefined;
    afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); dir = undefined; vi.restoreAllMocks(); });

    function scan(files: Record<string, string>, rules: string): unknown[] {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-rules-'));
        for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
        const out: string[] = [];
        vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => { out.push(String(chunk)); return true; });
        scanRulesCommand(dir, Object.keys(files).filter(f => f.endsWith('.ts')), { rules });
        return out.join('').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    }

    it('runs only the named rules and prints one JSON line per finding', () => {
        const code = "export function setup(fn: () => void) {\n  window.addEventListener('a', fn);\n  addEventListener('b', fn);\n}\n"
            + "// @ts-expect-error internal\nexport const r = (e: any) => e[Symbol.for('lib.internal.x')];\n";
        expect(scan({ 'a.ts': code }, 'env/bare-browser-global')).toEqual([
            { rule: 'env/bare-browser-global', file: 'a.ts', line: 3, severity: 'medium', message: expect.stringContaining('addEventListener') },
        ]);
    });

    it('rejects an unknown rule id rather than scanning nothing', () => {
        expect(() => scan({ 'a.ts': 'export {};\n' }, 'no/such-rule')).toThrow('Unknown rule(s): no/such-rule');
    });
});
