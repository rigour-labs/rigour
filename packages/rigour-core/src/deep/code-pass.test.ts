import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import type { InferenceProvider } from '../inference/types.js';
import { runCodePass } from './code-pass.js';
import type { FileFacts } from './fact-extractor.js';
import { parseVerdicts } from './self-check.js';

let dir: string | undefined;
afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); dir = undefined; });

const SOURCE = 'export function total(items: number[]) {\n  let sum = 0;\n  for (let i = 0; i <= items.length; i++) sum += items[i];\n  return sum;\n}\n';
const facts = { path: 'total.ts', language: 'typescript', classes: [], functions: [] } as unknown as FileFacts;

function finding(line: number, category: string, description: string) {
    return { category, severity: 'high', file: 'total.ts', line, description, suggestion: 's', confidence: 0.9 };
}

const isCheck = (prompt: string) => /^You reported \d+ defect/.test(prompt);

/** Review passes answer from `reviews` in turn; the self-check withdraws findings whose line is in `withdraw`. */
function fakeProvider(reviews: object[][], withdraw: number[]) {
    const prompts: string[] = [];
    const provider: InferenceProvider = {
        name: 'fake', isAvailable: async () => true, setup: async () => {}, dispose: () => {},
        analyze: async (prompt: string) => {
            prompts.push(prompt);
            if (isCheck(prompt)) {
                const listed = [...prompt.matchAll(/^(\d+)\. total\.ts:(\d+):/gm)];
                return JSON.stringify({ verdicts: listed.map(m => ({ n: Number(m[1]), real: !withdraw.includes(Number(m[2])) })) });
            }
            return JSON.stringify({ findings: reviews.shift() ?? [] });
        },
    };
    return { provider, prompts };
}

type Reference = { maxChars: number; prBody?: string; removed?: Record<string, Array<{ line: number; text: string[] }>> };

function run(provider: InferenceProvider, reference?: Reference) {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-pass-'));
    fs.writeFileSync(path.join(dir, 'total.ts'), SOURCE);
    return runCodePass(provider, [facts], { cwd: dir, inference: {}, maxSourceChars: 10_000, focusLines: { 'total.ts': [3] }, reference });
}

describe('runCodePass', () => {
    it('reviews once without reference material (the small tiers)', async () => {
        const { provider, prompts } = fakeProvider([[finding(3, 'correctness', 'off by one on `items`')]], []);
        const result = await run(provider);
        expect(prompts).toHaveLength(1);
        expect(result.findings.map(f => f.line)).toEqual([3]);
        expect([result.proposed, result.withdrawn]).toEqual([1, 0]);
    });

    it('does not repeat an identical pass when there is only one reference section', async () => {
        const { provider, prompts } = fakeProvider([[]], []);
        await run(provider, { maxChars: 4000, prBody: 'Sum the basket.' });
        expect(prompts).toHaveLength(1);
    });

    it('with reference material, reviews twice in opposite orders, merges, and keeps what one self-check call confirms', async () => {
        const { provider, prompts } = fakeProvider([
            [finding(3, 'correctness', 'reads past the end of `items`')],
            [finding(3, 'correctness', 'same bug seen again'), finding(2, 'consistency', 'style-ish claim about `sum`')],
        ], [2]);
        const result = await run(provider, {
            maxChars: 4000, prBody: 'Sum the basket.',
            removed: { 'total.ts': [{ line: 3, text: ['  for (let i = 0; i < items.length; i++) sum += items[i];'] }] },
        });
        const reviews = prompts.filter(p => !isCheck(p));
        expect(reviews).toHaveLength(2);
        expect(reviews[0].indexOf('PR DESCRIPTION')).toBeLessThan(reviews[0].indexOf('REMOVED by this change'));
        expect(reviews[1].indexOf('REMOVED by this change')).toBeLessThan(reviews[1].indexOf('PR DESCRIPTION'));
        expect(prompts.filter(isCheck)).toHaveLength(1);
        expect(result.findings.map(f => [f.line, f.category])).toEqual([[3, 'correctness']]);
        expect([result.proposed, result.withdrawn]).toEqual([2, 1]); // two distinct findings, one withdrawn
    });

    it('reads only well-formed verdicts from a self-check reply', () => {
        expect([...parseVerdicts('Sure! {"verdicts": [{"n": 1, "real": false}, {"n": 2, "real": true}, {"n": "3", "real": false}]}')])
            .toEqual([[1, false], [2, true]]);
        expect(parseVerdicts('I am not sure').size).toBe(0);
    });

    it('keeps every finding when the self-check call fails', async () => {
        const { provider } = fakeProvider([[finding(3, 'correctness', 'reads past the end of `items`')], []], []);
        const analyze = provider.analyze;
        provider.analyze = async (prompt, options) => isCheck(prompt) ? Promise.reject(new Error('timeout')) : analyze(prompt, options);
        const result = await run(provider, { maxChars: 4000, prBody: 'Sum the basket.', removed: { 'total.ts': [{ line: 3, text: ['x'] }] } });
        expect(result.findings.map(f => f.line)).toEqual([3]);
        expect(result.withdrawn).toBe(0);
    });

    it('starts no file after the deadline, and counts what it skipped', async () => {
        const { provider, prompts } = fakeProvider([[]], []);
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-pass-'));
        fs.writeFileSync(path.join(dir, 'total.ts'), SOURCE);
        const result = await runCodePass(provider, [facts, facts], { cwd: dir, inference: {}, maxSourceChars: 10_000, deadline: Date.now() - 1 });
        expect(prompts).toHaveLength(0);
        expect(result.skipped).toBe(2);
    });

    it('reviews files concurrently but reports them in file order', async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-pass-'));
        const names = ['a.ts', 'b.ts', 'c.ts'];
        for (const name of names) fs.writeFileSync(path.join(dir, name), SOURCE);
        let inFlight = 0;
        let peak = 0;
        const provider: InferenceProvider = {
            name: 'fake', isAvailable: async () => true, setup: async () => {}, dispose: () => {},
            analyze: async (prompt: string) => {
                inFlight++;
                peak = Math.max(peak, inFlight);
                const file = names.find(n => prompt.includes(n))!;
                await new Promise(resolve => setTimeout(resolve, file === 'a.ts' ? 30 : 5));
                inFlight--;
                return JSON.stringify({ findings: [{ ...finding(3, 'correctness', 'off by one'), file }] });
            },
        };
        const many = names.map(name => ({ ...facts, path: name }) as FileFacts);
        const result = await runCodePass(provider, many, { cwd: dir, inference: {}, maxSourceChars: 10_000, concurrency: 2 });
        expect(peak).toBe(2);
        expect(result.findings.map(f => f.file)).toEqual(names);
        expect(result.contexts.map(c => c.file)).toEqual(names);
    });
});
