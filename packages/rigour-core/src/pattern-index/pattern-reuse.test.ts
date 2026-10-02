import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PatternEntry, PatternIndex } from './types.js';

/** Topic vectors: one dimension per word, so similarity between texts is predictable. */
const TOPICS = ['retry', 'backoff', 'request', 'date', 'format', 'chart'];
const topicVector = (text: string) => TOPICS.map(t => (text.toLowerCase().includes(t) ? 1 : 0));

vi.mock('./embeddings.js', async (importOriginal) => {
    const real = await importOriginal<typeof import('./embeddings.js')>();
    return {
        ...real,
        generateEmbedding: async (text: string) => topicVector(text),
        embedPattern: async (p: { name: string; type: string; description?: string }) => topicVector(real.patternEmbeddingText(p)),
    };
});

const { patternEmbeddingText, EMBEDDING_TEXT_VERSION } = await import('./embeddings.js');
const { PatternMatcher, SEMANTIC_MATCH_FLOOR } = await import('./matcher.js');
const { PatternIndexer } = await import('./indexer.js');
const { assessPattern } = await import('./assess.js');

const pattern = (name: string, extra: Partial<PatternEntry> = {}): PatternEntry => ({
    id: name, type: 'function', name, file: 'src/util.ts', line: 1, endLine: 3, signature: '', description: '',
    keywords: [], hash: name, exported: true, usageCount: 0, indexedAt: '2026-10-02T00:00:00Z', ...extra,
});
const index = (patterns: PatternEntry[], version?: number): PatternIndex => ({
    version: '1.0.0', lastUpdated: '', rootDir: '/x', patterns, files: [],
    stats: { totalPatterns: patterns.length, totalFiles: 1, byType: {} as any, indexDurationMs: 0 },
    ...(version ? { embeddingTextVersion: version } : {}),
});

describe('pattern embedding text', () => {
    it('reads a name as words, which is what lets an intent find it', () => {
        expect(patternEmbeddingText({ name: 'retryWithBackoff', type: 'function' })).toBe('retry with backoff function');
        expect(patternEmbeddingText({ name: 'parse_csv-rows', type: 'function', description: 'Rows from a file' })).toBe('parse csv rows function Rows from a file');
    });
});

describe('matching by meaning', () => {
    it(`accepts a match by meaning at ${SEMANTIC_MATCH_FLOOR}, below the bar name matching keeps`, async () => {
        // The query shares 1 of 3 topics with the pattern: cosine 0.58, under the old 0.60.
        const retry = pattern('retryWithBackoff', { embedding: topicVector('retry backoff request') });
        const result = await new PatternMatcher(index([retry]), { useFuzzy: false }).match({ name: 'callAgain', intent: 'make the request work on a flaky network' });
        expect(result.matches.map(m => [m.pattern.name, m.matchType])).toEqual([['retryWithBackoff', 'semantic']]);
        expect(result.action).toBe('WARN');
    });

    it('returns nothing for an unrelated intent', async () => {
        const retry = pattern('retryWithBackoff', { embedding: topicVector('retry backoff request') });
        const result = await new PatternMatcher(index([retry]), { useFuzzy: false }).match({ name: 'drawPie', intent: 'render a pie chart' });
        expect(result.status).toBe('NO_MATCH');
    });
});

describe('enrichIndex', () => {
    it('re-embeds an index built from an older embedding text, and marks the version', async () => {
        const stale = index([pattern('formatDate', { embedding: [9, 9, 9, 9, 9, 9] })], 1);
        const enriched = await new PatternIndexer('/x', { useEmbeddings: true }).enrichIndex(stale);
        expect(enriched.embeddingTextVersion).toBe(EMBEDDING_TEXT_VERSION);
        expect(enriched.patterns[0].embedding).toEqual(topicVector('format date function'));
    });
});

describe('assessPattern', () => {
    let cwd: string;
    beforeEach(() => {
        cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'assess-'));
        fs.mkdirSync(path.join(cwd, 'src'));
        fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ dependencies: { 'react-dom': '18.2.0' } }));
        fs.writeFileSync(path.join(cwd, 'src/mount.ts'), 'export function mountApp(el) {\n  ReactDOM.render(<App />, el);\n}\n');
    });
    afterEach(() => fs.rmSync(cwd, { recursive: true, force: true }));

    it('blocks an exact duplicate and reports what is deprecated inside the function it would reuse', async () => {
        const mount = pattern('mountApp', { file: 'src/mount.ts', line: 1, endLine: 3 });
        const result = await assessPattern(cwd, index([mount]), { name: 'mountApp' });
        expect(result.action).toBe('BLOCK');
        expect(result.deprecations.map(d => d.replacement)).toEqual(['createRoot(container).render(<App />)']);
    });

    it('allows a name nothing resembles', async () => {
        const result = await assessPattern(cwd, index([pattern('mountApp', { file: 'src/mount.ts' })]), { name: 'exportPdfReport' });
        expect(result).toEqual({ action: 'ALLOW', suggestion: '', deprecations: [] });
    });
});
