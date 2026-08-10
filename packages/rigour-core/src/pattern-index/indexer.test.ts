/**
 * Pattern Indexer Tests
 * 
 * Comprehensive tests for the pattern indexer.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { PatternIndexer, savePatternIndex, loadPatternIndex } from './indexer.js';

describe('PatternIndexer', () => {
    let testDir: string;

    beforeEach(async () => {
        // Create a temporary test directory
        testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigour-test-'));
        await fs.mkdir(path.join(testDir, 'src'), { recursive: true });
    });

    afterEach(async () => {
        // Clean up
        await fs.rm(testDir, { recursive: true, force: true });
    });

    describe('buildIndex', () => {
        it('should index function declarations', async () => {
            await fs.writeFile(
                path.join(testDir, 'src', 'utils.ts'),
                `
/**
 * Format a date to a readable string.
 */
export function formatDate(date: Date): string {
    return date.toISOString();
}
                `
            );

            const indexer = new PatternIndexer(testDir);
            const index = await indexer.buildIndex();

            expect(index.patterns).toHaveLength(1);
            expect(index.patterns[0].name).toBe('formatDate');
            expect(index.patterns[0].type).toBe('function');
            expect(index.patterns[0].exported).toBe(true);
            expect(index.patterns[0].signature).toContain('date: Date');
            expect(index.patterns[0].description).toContain('Format a date');
        });

        it('should index source files nested in monorepo packages', async () => {
            const packageSrc = path.join(testDir, 'packages', 'api', 'src');
            await fs.mkdir(packageSrc, { recursive: true });
            await fs.writeFile(
                path.join(packageSrc, 'handler.ts'),
                'export function handleRequest() {}'
            );

            const indexer = new PatternIndexer(testDir);
            const index = await indexer.buildIndex();

            expect(index.files.map(file => file.path)).toContain(
                path.join('packages', 'api', 'src', 'handler.ts')
            );
            expect(index.patterns.some(pattern => pattern.name === 'handleRequest')).toBe(true);
        });

        it('should index arrow functions', async () => {
            await fs.writeFile(
                path.join(testDir, 'src', 'helpers.ts'),
                `
export const slugify = (text: string): string => {
    return text.toLowerCase().replace(/\\s+/g, '-');
};
                `
            );

            const indexer = new PatternIndexer(testDir);
            const index = await indexer.buildIndex();

            expect(index.patterns).toHaveLength(1);
            expect(index.patterns[0].name).toBe('slugify');
            expect(index.patterns[0].type).toBe('function');
        });

        it('should detect React hooks', async () => {
            await fs.writeFile(
                path.join(testDir, 'src', 'hooks.ts'),
                `
export const useAuth = () => {
    return { user: null, login: () => {} };
};
                `
            );

            const indexer = new PatternIndexer(testDir);
            const index = await indexer.buildIndex();

            expect(index.patterns).toHaveLength(1);
            expect(index.patterns[0].name).toBe('useAuth');
            expect(index.patterns[0].type).toBe('hook');
        });

        it('should index classes', async () => {
            await fs.writeFile(
                path.join(testDir, 'src', 'services.ts'),
                `
export class UserService {
    getUser(id: string) {
        return { id };
    }
}
                `
            );

            const indexer = new PatternIndexer(testDir);
            const index = await indexer.buildIndex();

            expect(index.patterns.some(p => p.name === 'UserService')).toBe(true);
            expect(index.patterns.find(p => p.name === 'UserService')?.type).toBe('class');
        });

        it('should detect error classes', async () => {
            await fs.writeFile(
                path.join(testDir, 'src', 'errors.ts'),
                `
export class ValidationError extends Error {
    constructor(message: string) {
        super(message);
    }
}
                `
            );

            const indexer = new PatternIndexer(testDir);
            const index = await indexer.buildIndex();

            expect(index.patterns[0].type).toBe('error');
        });

        it('should index interfaces', async () => {
            await fs.writeFile(
                path.join(testDir, 'src', 'types.ts'),
                `
export interface User {
    id: string;
    name: string;
    email: string;
}
                `
            );

            const indexer = new PatternIndexer(testDir);
            const index = await indexer.buildIndex();

            expect(index.patterns).toHaveLength(1);
            expect(index.patterns[0].name).toBe('User');
            expect(index.patterns[0].type).toBe('interface');
        });

        it('should index type aliases', async () => {
            await fs.writeFile(
                path.join(testDir, 'src', 'types.ts'),
                `
export type UserId = string;
                `
            );

            const indexer = new PatternIndexer(testDir);
            const index = await indexer.buildIndex();

            expect(index.patterns).toHaveLength(1);
            expect(index.patterns[0].type).toBe('type');
        });

        it('should index enums', async () => {
            await fs.writeFile(
                path.join(testDir, 'src', 'constants.ts'),
                `
export enum Status {
    Active = 'active',
    Inactive = 'inactive'
}
                `
            );

            const indexer = new PatternIndexer(testDir);
            const index = await indexer.buildIndex();

            expect(index.patterns).toHaveLength(1);
            expect(index.patterns[0].name).toBe('Status');
            expect(index.patterns[0].type).toBe('enum');
        });

        it('should index constants (all caps)', async () => {
            await fs.writeFile(
                path.join(testDir, 'src', 'config.ts'),
                `
export const API_URL = 'https://api.example.com';
export const MAX_RETRIES = 3;
                `
            );

            const indexer = new PatternIndexer(testDir);
            const index = await indexer.buildIndex();

            const constants = index.patterns.filter(p => p.type === 'constant');
            expect(constants.length).toBeGreaterThanOrEqual(1);
            expect(constants.some(c => c.name === 'API_URL')).toBe(true);
        });

        it('should track index statistics', async () => {
            await fs.writeFile(
                path.join(testDir, 'src', 'utils.ts'),
                `
export function foo() {}
export function bar() {}
export interface Baz {}
                `
            );

            const indexer = new PatternIndexer(testDir);
            const index = await indexer.buildIndex();

            expect(index.stats.totalPatterns).toBe(3);
            expect(index.stats.totalFiles).toBe(1);
            expect(index.stats.indexDurationMs).toBeGreaterThan(0);
        });

        it('should exclude test files by default', async () => {
            await fs.writeFile(path.join(testDir, 'src', 'utils.ts'), 'export function main() {}');
            await fs.writeFile(path.join(testDir, 'src', 'utils.test.ts'), 'export function testMain() {}');

            const indexer = new PatternIndexer(testDir);
            const index = await indexer.buildIndex();

            expect(index.patterns.every(p => !p.file.includes('.test.'))).toBe(true);
        });
    });

    describe('updateIndex (incremental)', () => {
        it('should only reindex changed files', async () => {
            // Initial index
            await fs.writeFile(
                path.join(testDir, 'src', 'a.ts'),
                'export function funcA() {}'
            );
            await fs.writeFile(
                path.join(testDir, 'src', 'b.ts'),
                'export function funcB() {}'
            );

            const indexer = new PatternIndexer(testDir);
            const initialIndex = await indexer.buildIndex();
            expect(initialIndex.patterns).toHaveLength(2);

            // Modify only one file
            await fs.writeFile(
                path.join(testDir, 'src', 'a.ts'),
                'export function funcA() {} export function funcA2() {}'
            );

            const updatedIndex = await indexer.updateIndex(initialIndex);
            expect(updatedIndex.patterns).toHaveLength(3);
        });
    });

    describe('savePatternIndex / loadPatternIndex', () => {
        it('should save and load index correctly', async () => {
            await fs.writeFile(
                path.join(testDir, 'src', 'utils.ts'),
                'export function myFunc() {}'
            );

            const indexer = new PatternIndexer(testDir);
            const index = await indexer.buildIndex();

            const indexPath = path.join(testDir, '.rigour', 'patterns.json');
            await savePatternIndex(index, indexPath);

            const loaded = await loadPatternIndex(indexPath);
            expect(loaded).not.toBeNull();
            expect(loaded!.patterns).toHaveLength(index.patterns.length);
            expect(loaded!.version).toBe(index.version);
        });

        it('should return null for non-existent index', async () => {
            const loaded = await loadPatternIndex('/non/existent/path.json');
            expect(loaded).toBeNull();
        });
    });
});
