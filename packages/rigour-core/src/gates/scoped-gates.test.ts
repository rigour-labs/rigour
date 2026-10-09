import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ContextGate } from './context.js';
import { DependencyGate } from './dependency.js';
import { LogicDriftGate } from './logic-drift.js';
import { StyleDriftGate } from './style-drift.js';

describe('gates on a scoped run', () => {
    let cwd: string;
    beforeEach(async () => { cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'rigour-scoped-')); });
    afterEach(async () => { await fs.remove(cwd); });

    it('context-drift reports only findings that cite a file in scope', async () => {
        await fs.outputFile(path.join(cwd, 'src/a.ts'), 'export const a = process.env.API_URL_PROD;\n');
        await fs.outputFile(path.join(cwd, 'src/b.ts'), 'export const b = process.env.API_URL_STAGING;\n');
        const gate = new ContextGate({ context: { enabled: true } } as any);
        const record = { anchors: [{ type: 'env', id: 'API_URL', confidence: 1 }] } as any;

        const unscoped = await gate.run({ cwd, record });
        const scoped = await gate.run({ cwd, record, patterns: ['src/a.ts'] });

        expect(unscoped.flatMap(f => f.files)).toEqual(expect.arrayContaining(['src/a.ts', 'src/b.ts']));
        expect(scoped.length).toBeGreaterThan(0);
        expect(scoped.every(f => f.files?.includes('src/a.ts'))).toBe(true);
    });

    it('context-drift reads Scala classes, case classes and qualified modifiers included', async () => {
        for (const name of ['Alpha', 'Beta', 'Gamma']) await fs.outputFile(path.join(cwd, `src/${name}.ts`), `export class ${name} {}\n`);
        await fs.outputFile(path.join(cwd, 'src/Rows.scala'), 'final case class deltaRow(id: Long)\nprivate[core] class epsilonRow\n');
        const gate = new ContextGate({ context: { enabled: true } } as any);
        const found = await gate.run({ cwd, record: { anchors: [] } as any });
        expect(found.map(f => [f.details, f.files])).toEqual([['Cross-file naming inconsistency: class names use camelCase in 2 places (dominant is PascalCase)', ['src/Rows.scala']]]);
    });

    it('dependency-guardian checks the manifest only when package.json is in scope', async () => {
        await fs.outputJson(path.join(cwd, 'package.json'), { dependencies: { 'left-pad': '1.0.0' } });
        await fs.outputFile(path.join(cwd, 'src/a.ts'), "import pad from 'left-pad';\n");
        const gate = new DependencyGate({ gates: { dependencies: { forbid: ['left-pad'] } } } as any);

        expect(await gate.run({ cwd, patterns: ['src/a.ts'] })).toEqual([]);
        const withManifest = await gate.run({ cwd, patterns: ['package.json'] });
        expect(withManifest.some(f => f.title === 'Forbidden Dependency')).toBe(true);
    });

    it('logic-drift never creates or rewrites its baseline from a scoped run', async () => {
        const baseline = path.join(cwd, '.rigour/logic-baseline.json');
        await fs.outputFile(path.join(cwd, 'src/rules.ts'), 'export function eligible(score: number) { return score >= 10; }\n');
        await fs.outputFile(path.join(cwd, 'src/other.ts'), 'export function other(n: number) { return n > 1; }\n');
        const gate = new LogicDriftGate();

        expect(await gate.run({ cwd, patterns: ['src/rules.ts'] })).toEqual([]);
        expect(await fs.pathExists(baseline)).toBe(false);

        await gate.run({ cwd });
        const before = await fs.readFile(baseline, 'utf-8');
        await fs.outputFile(path.join(cwd, 'src/rules.ts'), 'export function eligible(score: number) { return score > 10; }\n');

        const scoped = await gate.run({ cwd, patterns: ['src/rules.ts'] });
        expect(scoped.some(f => f.details.includes("'>=' to '>'"))).toBe(true);
        expect(await fs.readFile(baseline, 'utf-8')).toBe(before);
    });

    it('style-drift does not create its baseline from a scoped run', async () => {
        await fs.outputFile(path.join(cwd, 'src/a.ts'), 'export function doThing() { return 1; }\n');
        const gate = new StyleDriftGate();

        expect(await gate.run({ cwd, patterns: ['src/a.ts'] })).toEqual([]);
        expect(await fs.pathExists(path.join(cwd, '.rigour/style-baseline.json'))).toBe(false);
    });
});
