import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InferenceProvider } from '../inference/types.js';
import { runIntentChecks } from './deep-intent.js';

const DASHBOARD = [
    'declare function getAccount(id: string): Promise<{ name: string }>;',
    'declare function getRecommendedCourses(id: string): Promise<string[]>;',
    'export async function loadDashboard(id: string) {',
    '  const [account, recommended] = await Promise.all([getAccount(id), getRecommendedCourses(id)]);',
    '  return { account, recommended };',
    '}',
].join('\n');

/** Answers as if getRecommendedCourses were optional and getAccount required. */
function provider(calls: string[]): InferenceProvider {
    return {
        name: 'fake',
        isAvailable: async () => true,
        setup: async () => {},
        dispose: () => {},
        analyze: async (prompt: string) => {
            calls.push(prompt);
            const optional = /Question: [^\n]*getRecommendedCourses/.test(prompt);
            const ifFails = prompt.includes('Question: If');
            return JSON.stringify({ answer: ifFails === optional ? 'yes' : 'no' });
        },
    };
}

describe('runIntentChecks', () => {
    let cwd: string;
    beforeEach(() => { cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-intent-')); });
    afterEach(() => { fs.rmSync(cwd, { recursive: true, force: true }); });

    it('reports an optional read that can take down a required one', async () => {
        fs.writeFileSync(path.join(cwd, 'dashboard.ts'), DASHBOARD);
        const calls: string[] = [];
        const [failure, ...rest] = await runIntentChecks(cwd, ['dashboard.ts'], provider(calls));
        expect(rest).toHaveLength(0);
        expect(calls).toHaveLength(4);
        expect(failure).toMatchObject({
            id: 'deep-analysis', files: ['dashboard.ts'], line: 4, category: 'optional-read-no-fallback',
            provenance: 'deep-analysis', source: 'hybrid', verified: false,
        });
        expect(failure.details).toContain('`getRecommendedCourses` looks optional');
    });

    it('asks nothing when no file has an unhandled Promise.all', async () => {
        fs.writeFileSync(path.join(cwd, 'plain.ts'), 'export const x = 1;\n');
        const calls: string[] = [];
        expect(await runIntentChecks(cwd, ['plain.ts', 'README.md'], provider(calls))).toEqual([]);
        expect(calls).toEqual([]);
    });
});
