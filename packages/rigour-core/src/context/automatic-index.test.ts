import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureAutomaticIndex, mergeSemanticEmbeddings, updateAutomaticIndexForFiles } from './automatic-index.js';
import type { PatternIndex } from '../pattern-index/types.js';

describe('automatic incremental index', () => {
    const cwd = path.join(os.tmpdir(), `rigour-auto-index-${process.pid}`);
    afterEach(() => fs.remove(cwd));

    it('builds once and refreshes only changed files and their dependents', async () => {
        await fs.outputFile(path.join(cwd, 'src/value.ts'), 'export const value = 1;');
        await fs.outputFile(path.join(cwd, 'src/consumer.ts'), "import { value } from './value';\nexport const doubled = value * 2;");
        const baseline = await ensureAutomaticIndex(cwd, { backgroundSemantic: false });
        const untouched = baseline.files.find(file => file.path === 'src/consumer.ts')?.indexedAt;
        await fs.writeFile(path.join(cwd, 'src/value.ts'), 'export const value = 2;');
        const result = await updateAutomaticIndexForFiles(cwd, ['src/value.ts']);
        expect(result.affectedFiles.sort()).toEqual(['src/consumer.ts', 'src/value.ts']);
        expect(result.index.files.find(file => file.path === 'src/consumer.ts')?.indexedAt).not.toBe(untouched);
    });

    it('ignores changed-file paths outside the repository', async () => {
        await fs.outputFile(path.join(cwd, 'src/value.ts'), 'export const value = 1;');
        const baseline = await ensureAutomaticIndex(cwd, { backgroundSemantic: false });
        const result = await updateAutomaticIndexForFiles(cwd, [path.join(cwd, '..', 'outside.ts')]);

        expect(result.affectedFiles).toEqual([]);
        expect(result.index.patterns).toEqual(baseline.patterns);
    });

    it('merges background embeddings onto the latest structural snapshot', () => {
        const pattern = (id: string, file: string, embedding?: number[]) => ({
            id, file, embedding, type: 'function' as const, name: id, line: 1, endLine: 1,
            signature: '', description: '', keywords: [], hash: id, exported: true,
            usageCount: 0, indexedAt: '2026-09-10T00:00:00.000Z',
        });
        const makeIndex = (patterns: ReturnType<typeof pattern>[]): PatternIndex => ({
            version: '1.0.0', lastUpdated: '2026-09-10T00:00:00.000Z', rootDir: cwd,
            patterns,
            files: patterns.map(entry => ({ path: entry.file, hash: entry.hash, patternCount: 1, indexedAt: entry.indexedAt })),
            stats: { totalPatterns: patterns.length, totalFiles: patterns.length, byType: { function: patterns.length } as PatternIndex['stats']['byType'], indexDurationMs: 1 },
        });
        const latest = makeIndex([pattern('changed', 'src/changed.ts'), pattern('new', 'src/new.ts')]);
        const enriched = makeIndex([pattern('changed', 'src/old.ts', [0.1, 0.2]), pattern('deleted', 'src/deleted.ts', [0.3])]);

        const merged = mergeSemanticEmbeddings(latest, enriched);

        expect(merged.patterns.map(entry => entry.id)).toEqual(['changed', 'new']);
        expect(merged.patterns[0].file).toBe('src/changed.ts');
        expect(merged.patterns[0].embedding).toEqual([0.1, 0.2]);
    });
});
