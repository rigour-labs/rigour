import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { getRepositoryId, openDatabase, reinforcePattern } from '@rigour-labs/core';
import { loadPatterns } from './studio-patterns.js';

const now = new Date('2026-10-16T12:00:00Z');

function tempRepo(): string {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-patterns-'));
    fs.mkdirSync(path.join(repo, '.rigour'));
    return repo;
}

function write(repo: string, file: string, body: unknown): void {
    fs.writeFileSync(path.join(repo, '.rigour', file), typeof body === 'string' ? body : JSON.stringify(body));
}

describe('the function index, for the Patterns page', () => {
    it('counts what it holds by kind and by file, with whether matching by meaning is on', async () => {
        const repo = tempRepo();
        try {
            write(repo, 'patterns.json', {
                lastUpdated: '2026-10-15T09:00:00Z',
                patterns: [
                    { name: 'formatCents', type: 'function', file: 'src/money.ts', line: 3, exported: true },
                    { name: 'Money', type: 'interface', file: 'src/money.ts', line: 1, exported: true },
                    { name: 'useCart', type: 'hook', file: 'src/cart.ts', line: 8, exported: false },
                ],
                files: [{ path: 'src/money.ts', patternCount: 2 }, { path: 'src/cart.ts', patternCount: 1 }],
            });
            write(repo, 'index-status.json', { semantic: 'disabled' });
            const { index } = await loadPatterns(repo, undefined, now);
            expect(index).toMatchObject({ indexed: true, lastIndexed: '2026-10-15T09:00:00Z', total: 3, files: 2, more: 0, meaning: 'off' });
            expect(index.byType).toEqual([{ type: 'function', count: 1 }, { type: 'hook', count: 1 }, { type: 'interface', count: 1 }]);
            expect(index.topFiles[0]).toEqual({ file: 'src/money.ts', count: 2 });
            expect(index.entries[0]).toEqual({ name: 'formatCents', type: 'function', file: 'src/money.ts', line: 3, exported: true });
        } finally {
            fs.rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        }
    });
});

describe('reuse suggestions, for the Patterns page', () => {
    it('counts the last 28 days apart from all time, newest example first', async () => {
        const repo = tempRepo();
        try {
            write(repo, 'events.jsonl', [
                { type: 'reuse_suggested', timestamp: '2026-08-01T00:00:00Z', planned: 'old', existing: 'a in src/a.ts:1', action: 'WARN' },
                { type: 'reuse_suggested', timestamp: '2026-10-10T00:00:00Z', planned: 'formatMoney', existing: 'formatCents in src/money.ts:3', action: 'BLOCK' },
                { type: 'lessons_served', timestamp: '2026-10-10T00:00:00Z', lessons: ['x'] },
            ].map(e => JSON.stringify(e)).join('\n') + '\n');
            const { reuse } = await loadPatterns(repo, undefined, now);
            expect(reuse).toMatchObject({ days: 28, recent: 1, total: 2 });
            expect(reuse.examples[0]).toEqual({ at: '2026-10-10T00:00:00Z', planned: 'formatMoney', existing: 'formatCents in src/money.ts:3', action: 'BLOCK' });
        } finally {
            fs.rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        }
    });
});

describe('loadPatterns', () => {
    it('reads the index, its status, the recurring problem kinds and reuse events of this repository, and writes nothing', async () => {
        const repo = tempRepo();
        try {
            fs.writeFileSync(path.join(repo, '.rigour', 'patterns.json'), JSON.stringify({
                version: '1', lastUpdated: '2026-10-15T09:00:00Z', rootDir: repo,
                patterns: [{ id: '1', name: 'formatCents', type: 'function', file: 'src/money.ts', line: 3, exported: true, embedding: [0.1, 0.2] }],
                files: [{ path: 'src/money.ts', hash: 'h', patternCount: 1, indexedAt: '2026-10-15T09:00:00Z' }],
                stats: { totalPatterns: 1, totalFiles: 1, byType: {}, indexDurationMs: 4 },
            }));
            fs.writeFileSync(path.join(repo, '.rigour', 'index-status.json'), JSON.stringify({ structural: 'ready', graph: 'ready', semantic: 'ready', updatedAt: '2026-10-15T09:00:00Z' }));
            fs.writeFileSync(path.join(repo, '.rigour', 'events.jsonl'), `${JSON.stringify({ type: 'reuse_suggested', timestamp: '2026-10-12T00:00:00Z', planned: 'formatMoney', existing: 'formatCents in src/money.ts:3', action: 'BLOCK' })}\n`);
            const db = await openDatabase();
            expect(db).not.toBeNull();
            await reinforcePattern(db!, await getRepositoryId(repo), 'security-patterns', 'Hardcoded secret: a key in source', 'ast');
            await reinforcePattern(db!, await getRepositoryId(repo), 'security-patterns', 'Hardcoded secret: a key in source', 'ast');
            await reinforcePattern(db!, 'another-repository', 'other', 'not this one', 'ast');
            await db!.close();

            const before = fs.readdirSync(path.join(repo, '.rigour')).sort();
            const data = await loadPatterns(repo, undefined, now);
            expect(fs.readdirSync(path.join(repo, '.rigour')).sort()).toEqual(before);
            expect(data.index).toMatchObject({ indexed: true, total: 1, meaning: 'on' });
            expect(JSON.stringify(data.index)).not.toContain('embedding');
            expect(data.recurring.recorded).toBe(true);
            expect(data.recurring.patterns).toHaveLength(1);
            expect(data.recurring.patterns[0]).toMatchObject({ pattern: 'security-patterns', timesSeen: 2, description: 'Hardcoded secret: a key in source' });
            expect(data.reuse).toMatchObject({ recent: 1, total: 1 });
        } finally {
            fs.rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        }
    });

    it('says the index is missing rather than empty in a checkout never indexed', async () => {
        const repo = tempRepo();
        try {
            const data = await loadPatterns(repo, undefined, now);
            expect(data.index).toMatchObject({ indexed: false, lastIndexed: null, total: 0, meaning: null });
            expect(data.reuse).toMatchObject({ recent: 0, total: 0, examples: [] });
        } finally {
            fs.rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        }
    });
});
