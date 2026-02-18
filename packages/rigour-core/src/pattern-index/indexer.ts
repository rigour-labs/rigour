/**
 * Pattern Indexer
 *
 * Scans the codebase and extracts patterns using AST parsing.
 * This is the core engine of the Pattern Index system.
 *
 * Language-specific extractors live in indexer-lang.ts.
 * TypeScript/JS AST helpers live in indexer-ts.ts.
 * Pure utility functions live in indexer-helpers.ts.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { globby } from 'globby';
import ts from 'typescript';
import type {
    PatternEntry,
    PatternIndex,
    PatternIndexConfig,
    PatternIndexStats,
    IndexedFile,
} from './types.js';
import { generateEmbedding } from './embeddings.js';
import { hashContent } from './indexer-helpers.js';
import {
    extractGoPatterns,
    extractRustPatterns,
    extractJVMStylePatterns,
    extractPythonPatterns,
    extractGenericCPatterns,
} from './indexer-lang.js';
import { nodeToPattern } from './indexer-ts.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: PatternIndexConfig = {
    include: ['src/**/*', 'lib/**/*', 'app/**/*', 'components/**/*', 'utils/**/*', 'hooks/**/*', '**/tests/**/*', '**/test/**/*'],
    exclude: [
        '**/node_modules/**', '**/dist/**', '**/build/**', '**/.git/**',
        '**/coverage/**', '**/venv/**', '**/.venv/**', '**/__pycache__/**',
        '**/site-packages/**', '**/.pytest_cache/**', '**/target/**',
        '**/bin/**', '**/.gradle/**', '**/.mvn/**',
    ],
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java', '.cpp', '.h', '.rb', '.php', '.cs', '.kt'],
    indexTests: false,
    indexNodeModules: false,
    minNameLength: 2,
    categories: {},
    useEmbeddings: false,
};

const INDEX_VERSION = '1.0.0';

// ---------------------------------------------------------------------------
// PatternIndexer class
// ---------------------------------------------------------------------------

export class PatternIndexer {
    private config: PatternIndexConfig;
    private rootDir: string;

    constructor(rootDir: string, config: Partial<PatternIndexConfig> = {}) {
        this.rootDir = rootDir;
        this.config = { ...DEFAULT_CONFIG, ...config };
    }

    async buildIndex(): Promise<PatternIndex> {
        const startTime = Date.now();
        const files = await this.findFiles();

        const BATCH_SIZE = 10;
        const patterns: PatternEntry[] = [];
        const indexedFiles: IndexedFile[] = [];

        for (let i = 0; i < files.length; i += BATCH_SIZE) {
            const batch = files.slice(i, i + BATCH_SIZE);
            const results = await Promise.all(batch.map(async (file) => {
                try {
                    const relativePath = path.relative(this.rootDir, file);
                    const content = await fs.readFile(file, 'utf-8');
                    const fileHash = hashContent(content);
                    const filePatterns = await this.extractPatterns(file, content);
                    return {
                        patterns: filePatterns,
                        fileInfo: {
                            path: relativePath,
                            hash: fileHash,
                            patternCount: filePatterns.length,
                            indexedAt: new Date().toISOString(),
                        },
                    };
                } catch (error) {
                    console.error(`Error indexing ${file}:`, error);
                    return null;
                }
            }));

            for (const result of results) {
                if (result) {
                    patterns.push(...result.patterns);
                    indexedFiles.push(result.fileInfo);
                }
            }
        }

        if (this.config.useEmbeddings && patterns.length > 0) {
            process.stderr.write(`Generating embeddings for ${patterns.length} patterns...\n`);
            for (let i = 0; i < patterns.length; i += BATCH_SIZE) {
                const batch = patterns.slice(i, i + BATCH_SIZE);
                await Promise.all(batch.map(async (pattern) => {
                    pattern.embedding = await generateEmbedding(
                        `${pattern.name} ${pattern.type} ${pattern.description}`
                    );
                }));
            }
        }

        const endTime = Date.now();
        const stats = this.calculateStats(patterns, indexedFiles, endTime - startTime);

        return {
            version: INDEX_VERSION,
            lastUpdated: new Date().toISOString(),
            rootDir: this.rootDir,
            patterns,
            stats,
            files: indexedFiles,
        };
    }

    async updateIndex(existingIndex: PatternIndex): Promise<PatternIndex> {
        const startTime = Date.now();
        const files = await this.findFiles();

        const updatedPatterns: PatternEntry[] = [];
        const updatedFiles: IndexedFile[] = [];

        const existingFileMap = new Map(existingIndex.files.map(f => [f.path, f]));

        const BATCH_SIZE = 10;
        for (let i = 0; i < files.length; i += BATCH_SIZE) {
            const batch = files.slice(i, i + BATCH_SIZE);
            const results = await Promise.all(batch.map(async (file) => {
                const relativePath = path.relative(this.rootDir, file);
                const content = await fs.readFile(file, 'utf-8');
                const fileHash = hashContent(content);
                const existingFile = existingFileMap.get(relativePath);

                if (existingFile && existingFile.hash === fileHash) {
                    const existingPatterns = existingIndex.patterns.filter(p => p.file === relativePath);
                    return { patterns: existingPatterns, fileInfo: existingFile };
                }

                const filePatterns = await this.extractPatterns(file, content);
                return {
                    patterns: filePatterns,
                    fileInfo: {
                        path: relativePath,
                        hash: fileHash,
                        patternCount: filePatterns.length,
                        indexedAt: new Date().toISOString(),
                    },
                };
            }));

            for (const result of results) {
                updatedPatterns.push(...result.patterns);
                updatedFiles.push(result.fileInfo);
            }
        }

        if (this.config.useEmbeddings && updatedPatterns.length > 0) {
            for (let i = 0; i < updatedPatterns.length; i += BATCH_SIZE) {
                const batch = updatedPatterns.slice(i, i + BATCH_SIZE);
                await Promise.all(batch.map(async (pattern) => {
                    if (!pattern.embedding) {
                        pattern.embedding = await generateEmbedding(
                            `${pattern.name} ${pattern.type} ${pattern.description}`
                        );
                    }
                }));
            }
        }

        const endTime = Date.now();
        const stats = this.calculateStats(updatedPatterns, updatedFiles, endTime - startTime);

        return {
            version: INDEX_VERSION,
            lastUpdated: new Date().toISOString(),
            rootDir: this.rootDir,
            patterns: updatedPatterns,
            stats,
            files: updatedFiles,
        };
    }

    // -------------------------------------------------------------------------
    // Private helpers
    // -------------------------------------------------------------------------

    private async findFiles(): Promise<string[]> {
        const patterns = this.config.include
            .map(p => this.config.extensions.map(ext => (p.endsWith('*') ? `${p}${ext}` : p)))
            .flat();

        const exclude = [...this.config.exclude];
        if (!this.config.indexTests) {
            exclude.push('**/*.test.*', '**/*.spec.*', '**/__tests__/**');
        }

        return globby(patterns, {
            cwd: this.rootDir,
            absolute: true,
            ignore: exclude,
            gitignore: true,
        });
    }

    private async extractPatterns(filePath: string, content: string): Promise<PatternEntry[]> {
        const ext = path.extname(filePath).toLowerCase();
        const { rootDir, config } = this;

        if (ext === '.py') return extractPythonPatterns(filePath, content, rootDir, config.minNameLength);
        if (ext === '.go') return extractGoPatterns(filePath, content, rootDir);
        if (ext === '.rs') return extractRustPatterns(filePath, content, rootDir);
        if (ext === '.java' || ext === '.kt' || ext === '.cs') return extractJVMStylePatterns(filePath, content, rootDir);

        if (['.ts', '.tsx', '.js', '.jsx'].includes(ext)) {
            const patterns: PatternEntry[] = [];
            const relativePath = path.relative(this.rootDir, filePath);
            const sourceFile = ts.createSourceFile(
                filePath, content, ts.ScriptTarget.Latest, true, this.getScriptKind(filePath)
            );
            const visit = (node: ts.Node) => {
                const pattern = nodeToPattern(node, sourceFile, relativePath, content, config.minNameLength);
                if (pattern) patterns.push(pattern);
                ts.forEachChild(node, visit);
            };
            visit(sourceFile);
            return patterns;
        }

        return extractGenericCPatterns(filePath, content);
    }

    private getScriptKind(filePath: string): ts.ScriptKind {
        switch (path.extname(filePath).toLowerCase()) {
            case '.ts': return ts.ScriptKind.TS;
            case '.tsx': return ts.ScriptKind.TSX;
            case '.js': return ts.ScriptKind.JS;
            case '.jsx': return ts.ScriptKind.JSX;
            default: return ts.ScriptKind.TS;
        }
    }

    private calculateStats(
        patterns: PatternEntry[],
        files: IndexedFile[],
        durationMs: number,
    ): PatternIndexStats {
        const byType: Record<string, number> = {};
        for (const pattern of patterns) {
            byType[pattern.type] = (byType[pattern.type] || 0) + 1;
        }
        return {
            totalPatterns: patterns.length,
            totalFiles: files.length,
            byType: byType as PatternIndexStats['byType'],
            indexDurationMs: durationMs,
        };
    }
}

// ---------------------------------------------------------------------------
// Standalone utilities (re-exported through pattern-index/index.ts)
// ---------------------------------------------------------------------------

export async function savePatternIndex(index: PatternIndex, outputPath: string): Promise<void> {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, JSON.stringify(index, null, 2), 'utf-8');
}

export async function loadPatternIndex(indexPath: string): Promise<PatternIndex | null> {
    try {
        const content = await fs.readFile(indexPath, 'utf-8');
        return JSON.parse(content) as PatternIndex;
    } catch {
        return null;
    }
}

export function getDefaultIndexPath(rootDir: string): string {
    return path.join(rootDir, '.rigour', 'patterns.json');
}
