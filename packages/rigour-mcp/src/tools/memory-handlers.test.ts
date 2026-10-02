import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const shared = vi.hoisted(() => ({ calls: [] as Array<[string, string]> }));
vi.mock('@rigour-labs/core', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@rigour-labs/core')>()),
    shareMemoryLesson: async (_cwd: string, key: string, value: string) => { shared.calls.push([key, value]); return 'lesson-1'; },
    loadTeamConfiguration: async () => null,
}));

const { handleForget, handleRemember } = await import('./memory-handlers.js');
const { handleRecall } = await import('./memory-recall.js');

let repoA: string;
let repoB: string;
let home: string;
const realHome = process.env.HOME;
const text = (result: { content: Array<{ text: string }> }) => result.content.map(c => c.text).join('\n');

beforeEach(() => {
    repoA = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-a-'));
    repoB = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-b-'));
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-home-'));
    process.env.HOME = home;
    shared.calls = [];
});
afterEach(() => {
    process.env.HOME = realHome;
    for (const dir of [repoA, repoB, home]) fs.rmSync(dir, { recursive: true, force: true });
});

describe('memory scopes', () => {
    it("never returns another repository's memory", async () => {
        await handleRemember(repoA, 'deploy', 'Only deploy from main.');
        expect(text(await handleRecall(repoA))).toContain('Only deploy from main.');
        expect(text(await handleRecall(repoB))).not.toContain('Only deploy from main.');
    });

    it('reflects a memory added or forgotten since the last recall', async () => {
        await handleRemember(repoA, 'tests', 'Run vitest before committing.');
        expect(text(await handleRecall(repoA, { key: 'tests' }))).toContain('Run vitest');
        await handleRemember(repoA, 'db', 'Use the read replica for reports.');
        expect(text(await handleRecall(repoA))).toContain('read replica');
        await handleForget(repoA, 'tests');
        expect(text(await handleRecall(repoA, { key: 'tests' }))).toContain('NO MEMORY FOUND');
    });

    it('keeps a user memory for every repository, and lets a repository memory override it', async () => {
        await handleRemember(repoA, 'pr_size', 'Keep pull requests small.', 'user');
        expect(text(await handleRecall(repoB, { key: 'pr_size' }))).toContain('(user)');
        await handleRemember(repoB, 'pr_size', 'This repo allows one large migration PR.');
        expect(text(await handleRecall(repoB, { key: 'pr_size' }))).toContain('large migration');
        expect(text(await handleRecall(repoA, { key: 'pr_size' }))).toContain('Keep pull requests small.');
    });

    it('stores a team memory for the repository and shares it as a candidate, saying when teammates get it', async () => {
        const result = text(await handleRemember(repoA, 'retries', 'Use withRetry from lib/net.', 'team'));
        expect(shared.calls).toEqual([['retries', 'Use withRetry from lib/net.']]);
        expect(result).toContain('team mode is configured');
        expect(text(await handleRecall(repoA, { key: 'retries' }))).toContain('withRetry');
    });

    it('records memory_stored for Studio', async () => {
        await handleRemember(repoA, 'naming', 'Hooks are named useX.');
        const events = fs.readFileSync(path.join(repoA, '.rigour', 'events.jsonl'), 'utf8');
        expect(events).toContain('"type":"memory_stored"');
    });
});
