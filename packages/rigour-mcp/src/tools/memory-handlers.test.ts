import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleForget, handleRecall, handleRemember } from './memory-handlers.js';

let repoA: string;
let repoB: string;
const text = (result: { content: Array<{ text: string }> }) => result.content.map(c => c.text).join('\n');

beforeEach(() => {
    repoA = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-a-'));
    repoB = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-b-'));
});
afterEach(() => {
    fs.rmSync(repoA, { recursive: true, force: true });
    fs.rmSync(repoB, { recursive: true, force: true });
});

describe('memory recall', () => {
    it("never returns another repository's memory", async () => {
        await handleRemember(repoA, 'deploy', 'Only deploy from main.');
        expect(text(await handleRecall(repoA))).toContain('Only deploy from main.');
        expect(text(await handleRecall(repoB))).not.toContain('Only deploy from main.');
    });

    it('reflects a memory added or forgotten since the last recall', async () => {
        await handleRemember(repoA, 'tests', 'Run vitest before committing.');
        expect(text(await handleRecall(repoA, 'tests'))).toContain('Run vitest');
        await handleRemember(repoA, 'db', 'Use the read replica for reports.');
        expect(text(await handleRecall(repoA))).toContain('read replica');
        await handleForget(repoA, 'tests');
        expect(text(await handleRecall(repoA, 'tests'))).toContain('NO MEMORY FOUND');
    });
});
