import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigSchema } from '@rigour-labs/core';
import { handleCheck, handleGetFixPacket } from './quality-handlers.js';

let repo: string;
const git = (...args: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { encoding: 'utf8' });
const write = (rel: string, body: string) => { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), body); };

beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-packet-change-'));
    git('init', '-q', '-b', 'main');
    write('package.json', '{ "name": "demo", "type": "module" }\n');
    write('src/old.ts', "import { gone } from './gone.js';\nexport const old = gone;\n"); // old debt, on main
    git('add', '-A');
    git('commit', '-qm', 'main');
    git('checkout', '-qb', 'feat/retry');
    write('src/retry.ts', "import { send } from './mailer/send.js';\nexport const retry = send;\n"); // the agent's change
    git('add', '-A');
    git('commit', '-qm', 'retry');
});
afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

describe("the agent's work order follows the rule that holds it", () => {
    it('lists the change\'s proven issue as must-fix, and nothing from the untouched file', async () => {
        const config = ConfigSchema.parse({ version: 1 });
        const packet = (await handleGetFixPacket(repo, config)).content[0].text;
        expect(packet).toContain('1 must fix (blocks you)');
        expect(packet).toMatch(/MUST FIX 1\/1: \[\w+\] .*\n.*hallucinated-imports/);
        expect(packet).toContain('WHERE: src/retry.ts:1');
        expect(packet).not.toContain('src/old.ts');
        const check = (await handleCheck({ run: () => { throw new Error('no whole-repository scan'); } } as any, repo, {}, config)).content[0].text;
        expect(check).toContain('FAIL: 1 thing to fix in your change');
        expect(check).not.toContain('src/old.ts');
    });
});
