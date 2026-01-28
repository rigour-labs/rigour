/**
 * Pattern Matcher Tests
 * 
 * Comprehensive tests for the pattern matcher.
 */

import { describe, it, expect } from 'vitest';
import { PatternMatcher, checkPatternDuplicate } from './matcher.js';
import type { PatternIndex, PatternEntry } from './types.js';

// Helper to create a mock pattern
function createPattern(overrides: Partial<PatternEntry> = {}): PatternEntry {
    return {
        id: 'test-id',
        type: 'function',
        name: 'testFunction',
        file: 'src/utils.ts',
        line: 1,
        endLine: 5,
        signature: '(input: string): string',
        description: 'A test function',
        keywords: ['test', 'function'],
        hash: 'abc123',
        exported: true,
        usageCount: 0,
        indexedAt: new Date().toISOString(),
        ...overrides
    };
}

// Helper to create a mock index
function createIndex(patterns: PatternEntry[]): PatternIndex {
    return {
        version: '1.0.0',
        lastUpdated: new Date().toISOString(),
        rootDir: '/test',
        patterns,
        stats: {
            totalPatterns: patterns.length,
            totalFiles: 1,
            byType: { function: patterns.length } as any,
            indexDurationMs: 100
        },
        files: []
    };
}

describe('PatternMatcher', () => {
    describe('exact name match', () => {
        it('should find exact name matches with 100% confidence', async () => {
            const pattern = createPattern({ name: 'formatDate' });
            const index = createIndex([pattern]);
            const matcher = new PatternMatcher(index, { useEmbeddings: false });

            const result = await matcher.match({ name: 'formatDate' });

            expect(result.status).toBe('FOUND_SIMILAR');
            expect(result.matches).toHaveLength(1);
            expect(result.matches[0].matchType).toBe('exact');
            expect(result.matches[0].confidence).toBe(100);
        });

        it('should be case-insensitive for exact matches', async () => {
            const pattern = createPattern({ name: 'formatDate' });
            const index = createIndex([pattern]);
            const matcher = new PatternMatcher(index, { useEmbeddings: false });

            const result = await matcher.match({ name: 'FormatDate' });

            expect(result.matches).toHaveLength(1);
            expect(result.matches[0].matchType).toBe('exact');
        });

        it('should set action to BLOCK for exact matches', async () => {
            const pattern = createPattern({ name: 'formatDate' });
            const index = createIndex([pattern]);
            const matcher = new PatternMatcher(index, { useEmbeddings: false });

            const result = await matcher.match({ name: 'formatDate' });

            expect(result.action).toBe('BLOCK');
        });
    });

    describe('fuzzy name match', () => {
        it('should find fuzzy matches for similar names', async () => {
            const pattern = createPattern({ name: 'formatDate' });
            const index = createIndex([pattern]);
            const matcher = new PatternMatcher(index, { useEmbeddings: false });

            // 'formatDate' vs 'formatDates' have extremely high similarity
            const result = await matcher.match({ name: 'formatDates' });

            expect(result.status).toBe('FOUND_SIMILAR');
            expect(result.matches.some(m => m.matchType === 'fuzzy')).toBe(true);
        });

        it('should find matches for renamed patterns', async () => {
            const pattern = createPattern({
                name: 'formatDate',
                keywords: ['format', 'date']
            });
            const index = createIndex([pattern]);
            const matcher = new PatternMatcher(index, { useEmbeddings: false });

            const result = await matcher.match({ name: 'formatDateString' });

            expect(result.matches.length).toBeGreaterThan(0);
        });

        it('should not match completely unrelated names', async () => {
            const pattern = createPattern({ name: 'formatDate' });
            const index = createIndex([pattern]);
            const matcher = new PatternMatcher(index, { useEmbeddings: false });

            const result = await matcher.match({ name: 'sendEmail' });

            expect(result.status).toBe('NO_MATCH');
        });
    });

    describe('signature match', () => {
        it('should find matches with identical signatures', async () => {
            const pattern = createPattern({
                name: 'formatDate',
                signature: '(date: Date): string'
            });
            const index = createIndex([pattern]);
            const matcher = new PatternMatcher(index, { useEmbeddings: false });

            const result = await matcher.match({
                name: 'myDateFormatter',
                signature: '(date: Date): string'
            });

            expect(result.matches.some(m => m.matchType === 'signature')).toBe(true);
        });

        it('should match similar parameter patterns', async () => {
            const pattern = createPattern({
                name: 'formatDate',
                signature: '(date: Date, format: string): string'
            });
            const index = createIndex([pattern]);
            const matcher = new PatternMatcher(index, { useEmbeddings: false });

            const result = await matcher.match({
                signature: '(input: Date, pattern: string): string'
            });

            expect(result.matches.length).toBeGreaterThan(0);
        });
    });

    describe('keyword match', () => {
        it('should find matches based on keywords', async () => {
            const pattern = createPattern({
                name: 'formatDate',
                keywords: ['format', 'date', 'time']
            });
            const index = createIndex([pattern]);
            const matcher = new PatternMatcher(index, { useEmbeddings: false });

            const result = await matcher.match({
                keywords: ['date', 'format']
            });

            expect(result.matches.some(m => m.matchType === 'semantic')).toBe(true);
        });
    });

    describe('overrides', () => {
        it('should allow overridden patterns', async () => {
            const pattern = createPattern({ name: 'formatDate' });
            const index = createIndex([pattern]);
            const matcher = new PatternMatcher(index, { useEmbeddings: false }, [
                {
                    pattern: 'formatDate',
                    reason: 'Refactoring in progress',
                    createdAt: new Date().toISOString()
                }
            ]);

            const result = await matcher.match({ name: 'formatDate' });

            expect(result.status).toBe('OVERRIDE_ALLOWED');
            expect(result.action).toBe('ALLOW');
        });

        it('should support glob overrides', async () => {
            const pattern = createPattern({ name: 'formatDate' });
            const index = createIndex([pattern]);
            const matcher = new PatternMatcher(index, { useEmbeddings: false }, [
                {
                    pattern: 'format*',
                    reason: 'All format functions are exempt',
                    createdAt: new Date().toISOString()
                }
            ]);

            const result = await matcher.match({ name: 'formatDate' });

            expect(result.status).toBe('OVERRIDE_ALLOWED');
        });

        it('should ignore expired overrides', async () => {
            const pattern = createPattern({ name: 'formatDate' });
            const index = createIndex([pattern]);
            const matcher = new PatternMatcher(index, { useEmbeddings: false }, [
                {
                    pattern: 'formatDate',
                    reason: 'Expired override',
                    createdAt: '2020-01-01T00:00:00Z',
                    expiresAt: '2020-01-02T00:00:00Z' // Expired
                }
            ]);

            const result = await matcher.match({ name: 'formatDate' });

            expect(result.status).toBe('FOUND_SIMILAR');
        });
    });

    describe('configuration', () => {
        it('should respect minConfidence setting', async () => {
            const pattern = createPattern({ name: 'formatDate' });
            const index = createIndex([pattern]);
            const matcher = new PatternMatcher(index, { minConfidence: 95, useEmbeddings: false });

            // Fuzzy match won't meet 95% threshold
            const result = await matcher.match({ name: 'dateFormat' });

            // Should only include exact matches at 95%+ threshold
            expect(result.matches.every(m => m.confidence >= 95)).toBe(true);
        });

        it('should respect maxMatches setting', async () => {
            const patterns = [
                createPattern({ id: '1', name: 'formatDate1' }),
                createPattern({ id: '2', name: 'formatDate2' }),
                createPattern({ id: '3', name: 'formatDate3' }),
                createPattern({ id: '4', name: 'formatDate4' }),
            ];
            const index = createIndex(patterns);
            const matcher = new PatternMatcher(index, { maxMatches: 2, useEmbeddings: false });

            const result = await matcher.match({ name: 'formatDate' });

            expect(result.matches.length).toBeLessThanOrEqual(2);
        });
    });

    describe('suggestions', () => {
        it('should suggest importing exported patterns', async () => {
            const pattern = createPattern({
                name: 'formatDate',
                file: 'src/utils/date.ts',
                exported: true
            });
            const index = createIndex([pattern]);
            const matcher = new PatternMatcher(index, { useEmbeddings: false });

            const result = await matcher.match({ name: 'formatDate' });

            expect(result.suggestion).toContain('Import');
            expect(result.suggestion).toContain('src/utils/date.ts');
        });

        it('should suggest extracting non-exported patterns', async () => {
            const pattern = createPattern({
                name: 'formatDate',
                exported: false
            });
            const index = createIndex([pattern]);
            const matcher = new PatternMatcher(index, { useEmbeddings: false });

            const result = await matcher.match({ name: 'formatDate' });

            expect(result.suggestion).toContain('similar pattern');
        });
    });
});

describe('checkPatternDuplicate', () => {
    it('should be a quick helper for duplicate checking', async () => {
        const pattern = createPattern({ name: 'myUtil' });
        const index = createIndex([pattern]);

        const result = await checkPatternDuplicate(index, 'myUtil');

        expect(result.status).toBe('FOUND_SIMILAR');
    });
});
