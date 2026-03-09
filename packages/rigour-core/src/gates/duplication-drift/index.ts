/**
 * Duplication Drift Gate (v2)
 *
 * Detects when AI generates near-identical functions across files because
 * it doesn't remember what it already wrote. This is an AI-specific failure
 * mode — humans reuse via copy-paste (same file), AI re-invents (cross-file).
 *
 * v2 upgrades:
 * - tree-sitter AST node type sequences replace hand-rolled regex tokenizer
 * - Jaccard similarity on AST node multisets (structural, not textual)
 * - Catches duplicates even when every variable name is different
 * - MD5 kept as fast-path for exact matches, Jaccard runs on remaining pairs
 *
 * Detection strategy (three-pass):
 * 1. Extract function bodies, normalize text (strip comments/whitespace)
 * 2. Parse with tree-sitter → walk AST → collect node type multiset
 * 3. Generate semantic embeddings via all-MiniLM-L6-v2 (384D)
 * 4. Pass 1 (fast):     MD5 hash → exact duplicates (O(n), <10ms)
 * 5. Pass 2 (Jaccard):  AST node multiset similarity → structural near-duplicates (O(n²) bounded)
 * 6. Pass 3 (semantic):  Embedding cosine similarity → semantic duplicates (O(n²) bounded)
 * 7. Flag functions with similarity > threshold in different files
 *
 * Why AST node types > raw tokens:
 * - `getUserById(id) { return db.find(x => x.id === id) }`
 * - `fetchUser(userId) { return database.filter(u => u.id === userId)[0] }`
 * Both produce similar AST: [return_statement, call_expression, arrow_function,
 *   binary_expression, member_expression]. Variable names are invisible.
 */

import path from 'path';
import { Gate, GateContext } from '../base.js';
import { Failure, Provenance } from '../../types/index.js';
import { FileScanner } from '../../utils/scanner.js';
import { Logger } from '../../utils/logger.js';
import { languageAdapters } from '../language-adapters/index.js';
import { generateEmbedding } from '../../pattern-index/embeddings.js';
import {
    initTreeSitter,
    GRAMMAR_PATHS,
    languageCache,
    getParser,
    getGrammarDir,
    textTokenize,
    collectASTNodeTypes,
    findFunctionNodeAtLine,
    normalizeBody,
    extractFunctionBody,
} from './tokenizer.js';
import {
    FunctionSignature,
    hashBody,
    findDuplicateGroups,
    buildEmbeddingText,
    calculateSimilarity,
} from './similarity.js';

export interface DuplicationDriftConfig {
    enabled?: boolean;
    similarity_threshold?: number;  // 0-1, default 0.75 (Jaccard AST)
    semantic_threshold?: number;    // 0-1, default 0.85 (embedding cosine)
    semantic_enabled?: boolean;     // Toggle embedding Pass 3, default true
    min_body_lines?: number;        // Ignore trivial functions, default 5
    approved_duplications?: string[]; // Human-approved duplicate pairs (e.g. "fn1:fn2")
}

// Re-export public types from similarity module
export type { FunctionSignature };

export class DuplicationDriftGate extends Gate {
    private config: Required<DuplicationDriftConfig>;
    private parser: any = null;

    constructor(config: DuplicationDriftConfig = {}) {
        super('duplication-drift', 'AI Duplication Drift Detection');
        this.config = {
            enabled: config.enabled ?? true,
            similarity_threshold: config.similarity_threshold ?? 0.75,
            semantic_threshold: config.semantic_threshold ?? 0.85,
            semantic_enabled: config.semantic_enabled ?? true,
            min_body_lines: config.min_body_lines ?? 5,
            approved_duplications: config.approved_duplications ?? [],
        };
    }

    protected get provenance(): Provenance { return 'ai-drift'; }

    async run(context: GateContext): Promise<Failure[]> {
        if (!this.config.enabled) return [];

        // Try to init tree-sitter (non-blocking, falls back gracefully)
        const hasTreeSitter = await initTreeSitter();
        if (hasTreeSitter && !this.parser) {
            const Parser = getParser();
            this.parser = new Parser();
        }

        const failures: Failure[] = [];
        const functions: FunctionSignature[] = [];

        const scanPatterns = context.patterns || ['**/*.{ts,js,tsx,jsx,py,go,rs}'];
        const files = await FileScanner.findFiles({
            cwd: context.cwd,
            patterns: scanPatterns,
            ignore: [...(context.ignore || []), '**/node_modules/**', '**/dist/**', '**/*.test.*', '**/*.spec.*'],
        });

        Logger.info(`Duplication Drift: Scanning ${files.length} files (tree-sitter: ${hasTreeSitter ? 'ON' : 'fallback'})`);

        for (const file of files) {
            try {
                const { readFile } = await import('fs-extra');
                const content = await readFile(path.join(context.cwd, file), 'utf-8');
                const ext = path.extname(file);
                const adapter = languageAdapters.getAdapter(file);

                if (adapter?.id === 'js') {
                    this.extractJSFunctions(content, file, functions);
                } else if (adapter?.id === 'python') {
                    this.extractPyFunctions(content, file, functions);
                }

                // Generate AST tokens using tree-sitter if available
                if (hasTreeSitter && GRAMMAR_PATHS[ext]) {
                    await this.enrichWithASTTokens(content, ext, file, functions);
                }
            } catch (e) { }
        }

        // Pass 3 prep: Generate semantic embeddings for all extracted functions
        // (embedding generation is lazy — only runs when semantic_enabled is true)
        if (this.config.semantic_enabled && functions.length > 0) {
            const allIndices = functions.map((_, i) => i);
            await this.enrichWithEmbeddings(functions, allIndices);
        }

        const duplicateGroups = findDuplicateGroups(
            functions,
            this.config.similarity_threshold,
            this.config.semantic_threshold,
            this.config.semantic_enabled
        );

        // Build approved pairs set for fast lookup
        const approvedSet = new Set(
            (this.config.approved_duplications || []).map(s => s.toLowerCase())
        );

        for (const group of duplicateGroups) {
            // Check if this pair is human-approved
            const names = group.map(f => f.name).sort();
            const pairKey = names.join(':').toLowerCase();
            if (approvedSet.has(pairKey)) continue;

            const files = group.map(f => f.file);
            const locations = group.map(f => `${f.file}:${f.line} (${f.name})`).join(', ');

            const { similarity, method } = calculateSimilarity(group[0], group[1] || group[0]);
            const pct = (similarity * 100).toFixed(0);

            failures.push(this.createFailure(
                `AI Duplication Drift: Function '${group[0].name}' has ${group.length} near-identical copies (${pct}% similar via ${method})`,
                [...new Set(files)],
                `Found duplicate implementations at: ${locations}. Extract to a shared module and import.`,
                'Duplication Drift',
                group[0].line,
                undefined,
                'high'
            ));
        }

        return failures;
    }

    // ─── tree-sitter AST Tokenization ───────────────────────────────

    /**
     * Parse the file with tree-sitter, find function nodes that match
     * our extracted functions (by line number), and replace their token
     * multisets with AST node type sequences.
     */
    private async enrichWithASTTokens(
        content: string,
        ext: string,
        file: string,
        functions: FunctionSignature[]
    ): Promise<void> {
        if (!this.parser) return;

        const grammarRelPath = GRAMMAR_PATHS[ext];
        if (!grammarRelPath) return;

        try {
            // Load language (cached)
            if (!languageCache.has(ext)) {
                const grammarDir = getGrammarDir();
                const grammarPath = path.resolve(grammarDir, grammarRelPath);
                const Parser = getParser();
                const lang = await Parser.Language.load(grammarPath);
                languageCache.set(ext, lang);
            }
            const lang = languageCache.get(ext)!;
            this.parser.setLanguage(lang);

            const tree = this.parser.parse(content);

            // Find functions that belong to this file
            const fileFunctions = functions.filter(f => f.file === file);

            for (const fn of fileFunctions) {
                // Find the AST node at this function's line
                const node = findFunctionNodeAtLine(tree.rootNode, fn.line);
                if (node) {
                    fn.astTokens = collectASTNodeTypes(node);
                }
            }
        } catch (e) {
            // tree-sitter parse failed for this file — keep text tokens
            Logger.debug(`tree-sitter parse failed for ${file}: ${e}`);
        }
    }

    // ─── Function Extraction ────────────────────────────────────────

    private extractJSFunctions(content: string, file: string, functions: FunctionSignature[]) {
        const lines = content.split('\n');

        const patterns = [
            /^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/,
            /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|(\w+))\s*=>/,
            /^\s+(?:async\s+)?(\w+)\s*\(([^)]*)\)\s*\{/,
        ];

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            for (const pattern of patterns) {
                const match = line.match(pattern);
                if (match) {
                    const name = match[1];
                    const params = match[2] || '';
                    const body = extractFunctionBody(lines, i);

                    if (body.length >= this.config.min_body_lines) {
                        const normalized = normalizeBody(body.join('\n'));
                        functions.push({
                            name,
                            file,
                            line: i + 1,
                            paramCount: params ? params.split(',').length : 0,
                            bodyHash: hashBody(normalized),
                            bodyLength: body.length,
                            normalized,
                            // Start with text tokens, enrichWithASTTokens() upgrades if tree-sitter available
                            astTokens: textTokenize(normalized),
                        });
                    }
                    break;
                }
            }
        }
    }

    private extractPyFunctions(content: string, file: string, functions: FunctionSignature[]) {
        const lines = content.split('\n');

        for (let i = 0; i < lines.length; i++) {
            const match = lines[i].match(/^(?:\s*)(?:async\s+)?def\s+(\w+)\s*\(([^)]*)\)/);
            if (match) {
                const name = match[1];
                const params = match[2] || '';
                const indent = lines[i].match(/^(\s*)/)?.[1]?.length || 0;

                const body: string[] = [];
                for (let j = i + 1; j < lines.length; j++) {
                    const lineIndent = lines[j].match(/^(\s*)/)?.[1]?.length || 0;
                    if (lines[j].trim() === '' || lineIndent > indent) {
                        body.push(lines[j]);
                    } else {
                        break;
                    }
                }

                if (body.length >= this.config.min_body_lines) {
                    const normalized = normalizeBody(body.join('\n'));
                    functions.push({
                        name,
                        file,
                        line: i + 1,
                        paramCount: params ? params.split(',').length : 0,
                        bodyHash: hashBody(normalized),
                        bodyLength: body.length,
                        normalized,
                        astTokens: textTokenize(normalized),
                    });
                }
            }
        }
    }

    // ─── Semantic Embedding ─────────────────────────────────────────

    /**
     * Enrich functions with semantic embeddings for Pass 3.
     * Only called for functions not already claimed by Pass 1/2.
     * Uses generateEmbedding() from pattern-index/embeddings.ts.
     */
    private async enrichWithEmbeddings(functions: FunctionSignature[], indices: number[]): Promise<void> {
        Logger.info(`Semantic Pass 3: Generating embeddings for ${indices.length} functions`);
        for (const idx of indices) {
            const fn = functions[idx];
            try {
                const text = buildEmbeddingText(fn);
                fn.embedding = await generateEmbedding(text);
            } catch {
                // Embedding failed — skip this function for Pass 3
                Logger.debug(`Embedding generation failed for ${fn.file}:${fn.name}`);
            }
        }
    }
}
