import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@rigour-labs/core', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@rigour-labs/core')>()),
    listKnowledgeLessons: async () => [{ state: 'validated' }, { state: 'candidate' }, { state: 'promoted' }],
}));

const { summarizeKnowledge } = await import('./knowledge.js');

let cwd: string;
let home: string;
const realHome = process.env.RIGOUR_HOME;
beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-'));
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-home-'));
    process.env.RIGOUR_HOME = home;
});
afterEach(() => {
    if (realHome === undefined) delete process.env.RIGOUR_HOME;
    else process.env.RIGOUR_HOME = realHome;
    for (const dir of [cwd, home]) fs.rmSync(dir, { recursive: true, force: true });
});

describe('summarizeKnowledge', () => {
    it('counts what the learning features actually stored, not a placeholder', async () => {
        fs.mkdirSync(path.join(cwd, '.rigour'));
        fs.writeFileSync(path.join(cwd, '.rigour', 'memory.json'), JSON.stringify({ memories: { a: { value: 'x', timestamp: '' }, b: { value: 'y', timestamp: '' } } }));
        fs.mkdirSync(path.join(home, '.rigour'));
        fs.writeFileSync(path.join(home, '.rigour', 'memory.json'), JSON.stringify({ memories: { b: { value: 'y', timestamp: '' }, c: { value: 'z', timestamp: '' } } }));
        fs.writeFileSync(path.join(cwd, '.rigour', 'check-outcomes.json'), JSON.stringify({ 'ast: Too many parameters': { fixed: 0, dismissed: 6 } }));
        expect(await summarizeKnowledge(cwd)).toEqual({ memories: 3, lessons: 3, trustedLessons: 2, learnedRules: 0, indexedPatterns: 0, mutedChecks: 1 });
    });

    it('serves a recent summary from cache, and recomputes after a tool that changes knowledge', async () => {
        fs.mkdirSync(path.join(cwd, '.rigour'), { recursive: true });
        const write = (keys: string[]) => fs.writeFileSync(path.join(cwd, '.rigour', 'memory.json'), JSON.stringify({ memories: Object.fromEntries(keys.map(k => [k, { value: k, timestamp: '' }])) }));
        write(['a']);
        expect((await summarizeKnowledge(cwd, { now: 1_000 })).memories).toBe(1);
        write(['a', 'b']);
        expect((await summarizeKnowledge(cwd, { now: 2_000 })).memories).toBe(1);
        expect((await summarizeKnowledge(cwd, { now: 3_000, fresh: true })).memories).toBe(2);
        expect((await summarizeKnowledge(cwd, { now: 100_000 })).memories).toBe(2);
    });
});
