import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import type { InferenceProvider } from '../inference/types.js';
import { runCodePass } from './code-pass.js';
import type { FileFacts } from './fact-extractor.js';
import { parseVerdict } from './self-check.js';

let dir: string | undefined;
afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); dir = undefined; });

const SOURCE = 'export function total(items: number[]) {\n  let sum = 0;\n  for (let i = 0; i <= items.length; i++) sum += items[i];\n  return sum;\n}\n';
const facts = { path: 'total.ts', language: 'typescript', classes: [], functions: [] } as unknown as FileFacts;

function finding(line: number, category: string, description: string) {
    return { category, severity: 'high', file: 'total.ts', line, description, suggestion: 's', confidence: 0.9 };
}

/** Review passes answer from `reviews` in turn; self-checks withdraw findings whose line is in `withdraw`. */
function fakeProvider(reviews: object[][], withdraw: number[]) {
    const prompts: string[] = [];
    const provider: InferenceProvider = {
        name: 'fake', isAvailable: async () => true, setup: async () => {}, dispose: () => {},
        analyze: async (prompt: string) => {
            prompts.push(prompt);
            if (prompt.startsWith('You reported a defect')) {
                const line = Number(prompt.match(/REPORTED at total\.ts:(\d+)/)?.[1]);
                return JSON.stringify({ real: !withdraw.includes(line) });
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

    it('with reference material, reviews twice in opposite orders, merges, and keeps what the self-check confirms', async () => {
        const { provider, prompts } = fakeProvider([
            [finding(3, 'correctness', 'reads past the end of `items`')],
            [finding(3, 'correctness', 'same bug seen again'), finding(2, 'consistency', 'style-ish claim about `sum`')],
        ], [2]);
        const result = await run(provider, {
            maxChars: 4000, prBody: 'Sum the basket.',
            removed: { 'total.ts': [{ line: 3, text: ['  for (let i = 0; i < items.length; i++) sum += items[i];'] }] },
        });
        const reviews = prompts.filter(p => !p.startsWith('You reported a defect'));
        expect(reviews).toHaveLength(2);
        expect(reviews[0].indexOf('PR DESCRIPTION')).toBeLessThan(reviews[0].indexOf('REMOVED by this change'));
        expect(reviews[1].indexOf('REMOVED by this change')).toBeLessThan(reviews[1].indexOf('PR DESCRIPTION'));
        expect(prompts.filter(p => p.startsWith('You reported a defect'))).toHaveLength(2);
        expect(result.findings.map(f => [f.line, f.category])).toEqual([[3, 'correctness']]);
        expect([result.proposed, result.withdrawn]).toEqual([2, 1]); // two distinct findings, one withdrawn
    });

    it('reads a self-check reply only when it is a verdict', () => {
        expect(parseVerdict('{"real": false, "reason": "handled"}')).toBe(false);
        expect(parseVerdict('Sure! {"real": true}')).toBe(true);
        expect(parseVerdict('I am not sure')).toBeUndefined();
    });
});
