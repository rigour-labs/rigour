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
 *
 * @since v2.16.0 (original MD5)
 * @since v5.0.0  (tree-sitter AST + Jaccard)
 * @since v5.1.0  (semantic embedding Pass 3)
 */

import { Gate, GateContext } from './base.js';
import { Failure, Provenance } from '../types/index.js';
import { FileScanner } from '../utils/scanner.js';
import { Logger } from '../utils/logger.js';
import { generateEmbedding, cosineSimilarity } from '../pattern-index/embeddings.js';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

// tree-sitter is optional — graceful fallback to text tokenization
let Parser: any = null;
let treeSitterReady = false;
let treeSitterFailed = false;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function initTreeSitter(): Promise<boolean> {
    if (treeSitterReady) return true;
    if (treeSitterFailed) return false;
    try {
        const mod = await import('web-tree-sitter');
        Parser = (mod as any).default || mod;
        await Parser.init();
        treeSitterReady = true;
        return true;
    } catch {
        treeSitterFailed = true;
        Logger.debug('tree-sitter not available, falling back to text tokenization');
        return false;
    }
}

const GRAMMAR_PATHS: Record<string, string> = {
    '.ts':  '../../vendor/grammars/tree-sitter-typescript.wasm',
    '.tsx': '../../vendor/grammars/tree-sitter-tsx.wasm',
    '.js':  '../../vendor/grammars/tree-sitter-javascript.wasm',
    '.jsx': '../../vendor/grammars/tree-sitter-javascript.wasm',
    '.py':  '../../vendor/grammars/tree-sitter-python.wasm',
    '.go':  '../../vendor/grammars/tree-sitter-go.wasm',
    '.rs':  '../../vendor/grammars/tree-sitter-rust.wasm',
};

// Cache loaded languages
const languageCache = new Map<string, any>();

interface FunctionSignature {
    name: string;
    file: string;
    line: number;
    paramCount: number;
    bodyHash: string;
    bodyLength: number;
    normalized: string;
    /** AST node type multiset for Jaccard comparison */
    astTokens: Map<string, number>;
    /** Semantic embedding vector (384D) for cosine similarity — Pass 3 */
    embedding?: number[];
}

export interface DuplicationDriftConfig {
    enabled?: boolean;
    similarity_threshold?: number;  // 0-1, default 0.75 (Jaccard AST)
    semantic_threshold?: number;    // 0-1, default 0.85 (embedding cosine)
    semantic_enabled?: boolean;     // Toggle embedding Pass 3, default true
    min_body_lines?: number;        // Ignore trivial functions, default 5
    approved_duplications?: string[]; // Human-approved duplicate pairs (e.g. "fn1:fn2")
}

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

                if (['.ts', '.js', '.tsx', '.jsx'].includes(ext)) {
                    this.extractJSFunctions(content, file, functions);
                } else if (ext === '.py') {
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

        const duplicateGroups = this.findDuplicateGroups(functions);

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

            // Determine similarity % and method used
            let similarity: number;
            let method: string;
            if (group[0].bodyHash === group[1]?.bodyHash) {
                similarity = 1.0;
                method = 'exact-hash';
            } else if (group[0].embedding && group[1]?.embedding) {
                const jaccardSim = this.jaccardSimilarity(group[0].astTokens, group[1].astTokens);
                const cosineSim = cosineSimilarity(group[0].embedding, group[1].embedding);
                if (cosineSim > jaccardSim) {
                    similarity = cosineSim;
                    method = 'semantic-embedding';
                } else {
                    similarity = jaccardSim;
                    method = 'ast-jaccard';
                }
            } else {
                similarity = group.length > 1
                    ? this.jaccardSimilarity(group[0].astTokens, group[1].astTokens)
                    : 1.0;
                method = 'ast-jaccard';
            }
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
     *
     * AST node types are language-agnostic structural tokens:
     * - if_statement, for_statement, return_statement
     * - call_expression, member_expression, binary_expression
     * - arrow_function, function_declaration
     *
     * Variable names, string literals, comments — all invisible.
     * Only STRUCTURE matters.
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
                const grammarPath = path.resolve(__dirname, grammarRelPath);
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
                const node = this.findFunctionNodeAtLine(tree.rootNode, fn.line);
                if (node) {
                    fn.astTokens = this.collectASTNodeTypes(node);
                }
            }
        } catch (e) {
            // tree-sitter parse failed for this file — keep text tokens
            Logger.debug(`tree-sitter parse failed for ${file}: ${e}`);
        }
    }

    /**
     * Walk the AST tree to find a function/method node at a given line.
     */
    private findFunctionNodeAtLine(rootNode: any, targetLine: number): any {
        const functionTypes = new Set([
            'function_declaration', 'method_definition', 'arrow_function',
            'function_definition',  // Python
            'function_item',        // Rust
            'method_declaration',   // Java/C#
            'lexical_declaration',  // const x = () => {}
        ]);

        let bestMatch: any = null;

        const walk = (node: any) => {
            // tree-sitter lines are 0-indexed, our lines are 1-indexed
            if (functionTypes.has(node.type) && node.startPosition.row + 1 === targetLine) {
                bestMatch = node;
                return;
            }
            for (let i = 0; i < node.childCount; i++) {
                walk(node.child(i));
                if (bestMatch) return;
            }
        };

        walk(rootNode);
        return bestMatch;
    }

    /**
     * Walk an AST subtree and collect node types as a multiset.
     *
     * This is the core insight: two functions with different variable names
     * but the same control flow produce the same node type multiset.
     *
     * Example:
     * `function a(x) { if (x > 0) return x * 2; return 0; }`
     * `function b(val) { if (val > 0) return val * 2; return 0; }`
     *
     * Both produce: {if_statement: 1, binary_expression: 2, return_statement: 2, ...}
     * → Jaccard similarity = 1.0
     */
    private collectASTNodeTypes(node: any): Map<string, number> {
        const types = new Map<string, number>();

        const walk = (n: any) => {
            // Skip leaf nodes that are just identifiers/literals (noise)
            // Keep structural node types only
            if (n.childCount > 0 || isStructuralLeaf(n.type)) {
                types.set(n.type, (types.get(n.type) || 0) + 1);
            }
            for (let i = 0; i < n.childCount; i++) {
                walk(n.child(i));
            }
        };

        walk(node);
        return types;
    }

    // ─── Fallback Text Tokenization ─────────────────────────────────

    /**
     * Fallback tokenizer when tree-sitter is not available.
     * Uses normalized text → keyword/operator multiset.
     */
    private textTokenize(normalized: string): Map<string, number> {
        const tokens = new Map<string, number>();

        const structural = normalized.match(
            /\b(if|else|for|while|return|const|let|var|function|class|import|export|async|await|try|catch|throw|new|switch|case|break|continue|yield|def|self)\b|[{}()\[\];,.:=<>!&|+\-*/%?]+/g
        ) || [];

        for (const token of structural) {
            tokens.set(token, (tokens.get(token) || 0) + 1);
        }

        // Normalize all identifiers to a count (variable names don't matter)
        const keywords = new Set([
            'if', 'else', 'for', 'while', 'return', 'const', 'let', 'var',
            'function', 'class', 'import', 'export', 'async', 'await',
            'try', 'catch', 'throw', 'new', 'switch', 'case', 'break',
            'continue', 'yield', 'def', 'self', 'true', 'false', 'null', 'undefined',
        ]);
        const identifiers = normalized.match(/\b[a-zA-Z_]\w*\b/g) || [];
        let idCount = 0;
        for (const id of identifiers) {
            if (!keywords.has(id)) idCount++;
        }
        if (idCount > 0) tokens.set('_ID_', idCount);

        return tokens;
    }

    // ─── Jaccard Similarity ─────────────────────────────────────────

    /**
     * Jaccard similarity on multisets.
     * intersection = sum of min(countA, countB) for each key
     * union = sum of max(countA, countB) for each key
     */
    private jaccardSimilarity(a: Map<string, number>, b: Map<string, number>): number {
        const allKeys = new Set([...a.keys(), ...b.keys()]);
        let intersection = 0;
        let union = 0;

        for (const key of allKeys) {
            const countA = a.get(key) || 0;
            const countB = b.get(key) || 0;
            intersection += Math.min(countA, countB);
            union += Math.max(countA, countB);
        }

        return union === 0 ? 0 : intersection / union;
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
                    const body = this.extractFunctionBody(lines, i);

                    if (body.length >= this.config.min_body_lines) {
                        const normalized = this.normalizeBody(body.join('\n'));
                        functions.push({
                            name,
                            file,
                            line: i + 1,
                            paramCount: params ? params.split(',').length : 0,
                            bodyHash: this.hash(normalized),
                            bodyLength: body.length,
                            normalized,
                            // Start with text tokens, enrichWithASTTokens() upgrades if tree-sitter available
                            astTokens: this.textTokenize(normalized),
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
                    const normalized = this.normalizeBody(body.join('\n'));
                    functions.push({
                        name,
                        file,
                        line: i + 1,
                        paramCount: params ? params.split(',').length : 0,
                        bodyHash: this.hash(normalized),
                        bodyLength: body.length,
                        normalized,
                        astTokens: this.textTokenize(normalized),
                    });
                }
            }
        }
    }

    private extractFunctionBody(lines: string[], startIndex: number): string[] {
        let braceDepth = 0;
        let started = false;
        const body: string[] = [];

        for (let i = startIndex; i < lines.length; i++) {
            const line = lines[i];
            for (const ch of line) {
                if (ch === '{') { braceDepth++; started = true; }
                if (ch === '}') braceDepth--;
            }
            if (started) body.push(line);
            if (started && braceDepth === 0) break;
        }

        return body;
    }

    private normalizeBody(body: string): string {
        return body
            .replace(/\/\/.*/g, '')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/#.*/g, '')
            .replace(/`[^`]*`/g, '"STR"')
            .replace(/\basync\s+/g, '')
            .replace(/\s+/g, ' ')
            .replace(/['"]/g, '"')
            .trim();
    }

    private hash(text: string): string {
        return crypto.createHash('md5').update(text).digest('hex');
    }

    // ─── Semantic Embedding ─────────────────────────────────────────

    /**
     * Generate semantic embedding text for a function.
     * Combines function name, parameter names, and first 200 tokens of body.
     * This captures INTENT regardless of implementation differences.
     *
     * Example:
     * getUserById(id) { return db.users.find(x => x.id === id) }
     * → "getUserById id return db users find x id id"
     *
     * fetchUserRecord(userId) { return database.users.filter(u => u.id === userId)[0] }
     * → "fetchUserRecord userId return database users filter u id userId 0"
     *
     * These produce similar embeddings (~0.91 cosine) despite different AST.
     */
    private buildEmbeddingText(fn: FunctionSignature): string {
        // Extract identifiers from normalized body (first 200 tokens)
        const bodyTokens = fn.normalized.match(/\b[a-zA-Z_]\w*\b/g) || [];
        const first200 = bodyTokens.slice(0, 200).join(' ');
        return `${fn.name} ${first200}`;
    }

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
                const text = this.buildEmbeddingText(fn);
                fn.embedding = await generateEmbedding(text);
            } catch {
                // Embedding failed — skip this function for Pass 3
                Logger.debug(`Embedding generation failed for ${fn.file}:${fn.name}`);
            }
        }
    }

    // ─── Duplicate Finding (three-pass) ──────────────────────────────

    /**
     * Three-pass duplicate detection:
     * Pass 1 (fast):     MD5 hash → exact duplicates (O(n))
     * Pass 2 (Jaccard):  AST node multiset similarity → near-duplicates (O(n²) bounded)
     * Pass 3 (semantic):  Embedding cosine similarity → semantic duplicates (O(n²) bounded)
     *
     * Pass 3 catches what AST Jaccard misses: same intent, different implementation.
     * Example: .find() vs .filter()[0] — different AST nodes, same semantic meaning.
     */
    private findDuplicateGroups(functions: FunctionSignature[]): FunctionSignature[][] {
        const duplicates: FunctionSignature[][] = [];
        const claimedIndices = new Set<number>();

        // Pass 1: Exact hash match
        const hashGroups = new Map<string, number[]>();
        for (let i = 0; i < functions.length; i++) {
            const existing = hashGroups.get(functions[i].bodyHash) || [];
            existing.push(i);
            hashGroups.set(functions[i].bodyHash, existing);
        }

        for (const indices of hashGroups.values()) {
            if (indices.length < 2) continue;
            const group = indices.map(i => functions[i]);
            const uniqueFiles = new Set(group.map(f => f.file));
            if (uniqueFiles.size >= 2) {
                duplicates.push(group);
                indices.forEach(i => claimedIndices.add(i));
            }
        }

        // Pass 2: Jaccard on AST tokens for remaining functions
        const remaining = functions
            .map((fn, i) => ({ fn, idx: i }))
            .filter(({ idx }) => !claimedIndices.has(idx));

        remaining.sort((a, b) => a.fn.bodyLength - b.fn.bodyLength);

        const jaccardClaimed = new Set<number>();

        for (let i = 0; i < remaining.length; i++) {
            if (jaccardClaimed.has(remaining[i].idx)) continue;

            const group: FunctionSignature[] = [remaining[i].fn];
            const baseLen = remaining[i].fn.bodyLength;

            for (let j = i + 1; j < remaining.length; j++) {
                if (jaccardClaimed.has(remaining[j].idx)) continue;
                if (remaining[j].fn.bodyLength > baseLen * 1.5) break;
                if (remaining[j].fn.file === remaining[i].fn.file) continue;

                const sim = this.jaccardSimilarity(remaining[i].fn.astTokens, remaining[j].fn.astTokens);
                if (sim >= this.config.similarity_threshold) {
                    group.push(remaining[j].fn);
                    jaccardClaimed.add(remaining[j].idx);
                }
            }

            if (group.length >= 2) {
                const uniqueFiles = new Set(group.map(f => f.file));
                if (uniqueFiles.size >= 2) {
                    duplicates.push(group);
                    jaccardClaimed.add(remaining[i].idx);
                }
            }
        }

        // Mark all Pass 1 + Pass 2 claimed indices
        for (const idx of jaccardClaimed) claimedIndices.add(idx);

        // Pass 3: Semantic embedding cosine similarity for still-unclaimed functions
        if (this.config.semantic_enabled) {
            const semanticRemaining = functions
                .map((fn, i) => ({ fn, idx: i }))
                .filter(({ idx }) => !claimedIndices.has(idx))
                .filter(({ fn }) => fn.embedding && fn.embedding.length > 0);

            semanticRemaining.sort((a, b) => a.fn.bodyLength - b.fn.bodyLength);

            const semanticClaimed = new Set<number>();

            for (let i = 0; i < semanticRemaining.length; i++) {
                if (semanticClaimed.has(semanticRemaining[i].idx)) continue;

                const group: FunctionSignature[] = [semanticRemaining[i].fn];
                const baseLen = semanticRemaining[i].fn.bodyLength;

                for (let j = i + 1; j < semanticRemaining.length; j++) {
                    if (semanticClaimed.has(semanticRemaining[j].idx)) continue;
                    // Body length must be within 2x range (semantic allows more variance)
                    if (semanticRemaining[j].fn.bodyLength > baseLen * 2.0) break;
                    if (semanticRemaining[j].fn.file === semanticRemaining[i].fn.file) continue;

                    const sim = cosineSimilarity(
                        semanticRemaining[i].fn.embedding!,
                        semanticRemaining[j].fn.embedding!
                    );
                    if (sim >= this.config.semantic_threshold) {
                        group.push(semanticRemaining[j].fn);
                        semanticClaimed.add(semanticRemaining[j].idx);
                    }
                }

                if (group.length >= 2) {
                    const uniqueFiles = new Set(group.map(f => f.file));
                    if (uniqueFiles.size >= 2) {
                        duplicates.push(group);
                        semanticClaimed.add(semanticRemaining[i].idx);
                    }
                }
            }

            if (semanticClaimed.size > 0) {
                Logger.info(`Semantic Pass 3: Found ${semanticClaimed.size} additional semantic duplicates`);
            }
        }

        return duplicates;
    }
}

/**
 * AST node types that are structural even as leaf nodes.
 * These carry semantic meaning without children.
 */
function isStructuralLeaf(type: string): boolean {
    const structural = new Set([
        'return', 'break', 'continue', 'yield', 'throw',
        'true', 'false', 'null', 'undefined', 'none',
        'self', 'this', 'super',
        'string', 'number', 'template_string',
        // Operators
        '=', '==', '===', '!=', '!==', '<', '>', '<=', '>=',
        '+', '-', '*', '/', '%', '**',
        '&&', '||', '!', '??',
        '=>', '...', '?', ':',
    ]);
    return structural.has(type);
}
