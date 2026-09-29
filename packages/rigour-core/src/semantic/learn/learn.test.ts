import fs from 'fs';
import os from 'os';
import path from 'path';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'url';
import { forEachNode } from '../ast.js';
import { loadLearnCases, runLearnCase } from './benchmark.js';
import { guardsOf, namesIn, propertiesNamed } from './conditions.js';
import { functionKeyOf, isInvocation } from './identity.js';
import { loadLearnedRules, saveLearnedRule } from './store.js';
import type { LearnedRule } from './types.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../benchmarks/learn');

describe('learn benchmark', () => {
    for (const bench of loadLearnCases(ROOT)) {
        it(`${bench.name}: ${bench.note}`, async () => {
            const result = await runLearnCase(ROOT, bench);
            expect(result.problems).toEqual([]);
        });
    }
});

function parse(text: string): ts.SourceFile {
    return ts.createSourceFile('x.ts', text, ts.ScriptTarget.Latest, true);
}

function firstCall(sf: ts.SourceFile): ts.CallExpression | ts.NewExpression {
    let call: ts.CallExpression | ts.NewExpression | undefined;
    forEachNode(sf, (n) => { if (!call && isInvocation(n)) call = n; });
    return call!;
}

describe('guardsOf', () => {
    it('collects the spread condition and the value condition', () => {
        const sf = parse("h({ ...(ok ? { 'cache-control': fresh ? 'max-age=1' : 'no-store' } : {}) });");
        const [prop] = propertiesNamed(sf, 'cache-control');
        expect(namesIn(guardsOf(prop, firstCall(sf)))).toEqual(['fresh', 'ok']);
    });

    it('lists property names before receivers', () => {
        const sf = parse("h({ c: status === 200 && body.stepsAvailable !== false ? 'a' : 'b' });");
        const [prop] = propertiesNamed(sf, 'c');
        expect(namesIn(guardsOf(prop, firstCall(sf)))[0]).toBe('stepsAvailable');
    });
});

describe('functionKeyOf', () => {
    it('names nested arrows, methods and the module level', () => {
        const sf = parse('class A { run() { const inner = () => f(); } }\ng();\n');
        const keys: string[] = [];
        forEachNode(sf, (n) => { if (isInvocation(n)) keys.push(functionKeyOf(n)); });
        expect(keys).toEqual(['A.run>inner', '<module>']);
    });
});

describe('learned rule store', () => {
    let dir: string | undefined;
    afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); dir = undefined; });

    it('round-trips a rule and skips files that are not rules', () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'learned-'));
        const rule: LearnedRule = {
            id: 'require-option-redirect-abcd1234', version: 1,
            pattern: { template: 'require-option', callee: { level: 'name', key: 'fetch' }, argIndex: 1, property: 'redirect' },
            message: 'm', severity: 'medium', source: { file: 'http.ts', function: 'post' },
            validation: { firesBefore: 1, firesAfter: 0, maxHits: 3, repoHits: [] },
        };
        saveLearnedRule(dir, rule);
        fs.writeFileSync(path.join(dir, '.rigour', 'rules', 'broken.json'), '{"id": 1}');
        expect(loadLearnedRules(dir)).toEqual([rule]);
    });
});
