import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LogicDriftGate } from './logic-drift.js';

describe('LogicDriftGate Git baseline', () => {
    let cwd: string;
    const git = (...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' });

    beforeEach(() => {
        cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'logic-drift-'));
        git('init', '-q', '-b', 'main');
        git('config', 'user.name', 'Rigour Test');
        git('config', 'user.email', 'test@example.invalid');
        fs.mkdirSync(path.join(cwd, 'src'));
        fs.writeFileSync(path.join(cwd, 'src/rules.ts'), 'export function eligible(score: number) { return score >= 10; }\n');
        git('add', '.');
        git('commit', '-qm', 'base');
    });

    afterEach(() => { fs.rmSync(cwd, { recursive: true, force: true }); });

    it('reports a branch mutation consistently and clears it after merge', async () => {
        const gate = new LogicDriftGate();
        expect(await gate.run({ cwd })).toEqual([]);
        git('switch', '-q', '-c', 'feature');
        fs.writeFileSync(path.join(cwd, 'src/rules.ts'), 'export function eligible(score: number) { return score > 10; }\n');

        const first = await gate.run({ cwd });
        const second = await gate.run({ cwd });
        expect(first).toEqual(second);
        expect(first).toHaveLength(1);
        expect(first.some(finding => finding.details.includes("'>=' to '>'"))).toBe(true);
        expect(fs.existsSync(path.join(cwd, '.rigour/logic-baseline.json'))).toBe(false);

        git('add', '.');
        git('commit', '-qm', 'change boundary');
        git('switch', '-q', 'main');
        git('merge', '-q', '--ff-only', 'feature');
        expect(await gate.run({ cwd })).toEqual([]);
    }, 30_000);

    it('does not use a moving local snapshot when Git has no main reference', async () => {
        git('switch', '-q', '-c', 'feature');
        git('branch', '-D', 'main');
        const gate = new LogicDriftGate();
        expect(await gate.run({ cwd })).toEqual([]);
        expect(fs.existsSync(path.join(cwd, '.rigour/logic-baseline.json'))).toBe(false);
    });
});
