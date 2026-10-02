import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PatternIndex } from '../pattern-index/types.js';
import { getAutomaticIndexStatus, recordIndexChoice } from './automatic-index.js';

let cwd: string;
beforeEach(() => { cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'index-status-')); });
afterEach(() => fs.rmSync(cwd, { recursive: true, force: true }));

const index = (embedded: boolean): PatternIndex => ({
    version: '1.0.0', lastUpdated: '', rootDir: cwd, files: [],
    patterns: [{ id: 'a', type: 'function', name: 'a', file: 'a.ts', line: 1, endLine: 1, signature: '', description: '', keywords: [], hash: 'a', exported: true, usageCount: 0, indexedAt: '', ...(embedded ? { embedding: [0.1] } : {}) }],
    stats: { totalPatterns: 1, totalFiles: 1, byType: {} as any, indexDurationMs: 0 },
});

describe('semantic index status', () => {
    it('treats no status yet as warming, not as an opt-out', async () => {
        expect((await getAutomaticIndexStatus(cwd)).semantic).toBe('warming');
    });

    it('records what an explicit index chose, so automatic indexing and Studio agree', async () => {
        await recordIndexChoice(cwd, index(false), false);
        expect((await getAutomaticIndexStatus(cwd)).semantic).toBe('disabled');
        await recordIndexChoice(cwd, index(true), true);
        expect((await getAutomaticIndexStatus(cwd)).semantic).toBe('ready');
        await recordIndexChoice(cwd, index(false), true);
        expect((await getAutomaticIndexStatus(cwd)).semantic).toBe('degraded');
    });
});
