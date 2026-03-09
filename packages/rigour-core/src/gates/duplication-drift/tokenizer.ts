/**
 * Duplication Drift Tokenizer
 *
 * Handles language-aware tokenization of code functions.
 * Supports tree-sitter AST-based tokenization with fallback to text-based.
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { Logger } from '../../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// tree-sitter is optional — graceful fallback to text tokenization
let Parser: any = null;
let treeSitterReady = false;
let treeSitterFailed = false;

export async function initTreeSitter(): Promise<boolean> {
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

export const GRAMMAR_PATHS: Record<string, string> = {
    '.ts':  '../../vendor/grammars/tree-sitter-typescript.wasm',
    '.tsx': '../../vendor/grammars/tree-sitter-tsx.wasm',
    '.js':  '../../vendor/grammars/tree-sitter-javascript.wasm',
    '.jsx': '../../vendor/grammars/tree-sitter-javascript.wasm',
    '.py':  '../../vendor/grammars/tree-sitter-python.wasm',
    '.go':  '../../vendor/grammars/tree-sitter-go.wasm',
    '.rs':  '../../vendor/grammars/tree-sitter-rust.wasm',
};

// Cache loaded languages
export const languageCache = new Map<string, any>();

/**
 * AST node types that are structural even as leaf nodes.
 * These carry semantic meaning without children.
 */
export function isStructuralLeaf(type: string): boolean {
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

/**
 * Fallback tokenizer when tree-sitter is not available.
 * Uses normalized text → keyword/operator multiset.
 */
export function textTokenize(normalized: string): Map<string, number> {
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
export function collectASTNodeTypes(node: any): Map<string, number> {
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

/**
 * Walk the AST tree to find a function/method node at a given line.
 */
export function findFunctionNodeAtLine(rootNode: any, targetLine: number): any {
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
 * Normalize function body text for tokenization.
 * Removes comments, normalizes whitespace, etc.
 */
export function normalizeBody(body: string): string {
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

/**
 * Extract function body from lines starting at startIndex.
 * Handles brace matching.
 */
export function extractFunctionBody(lines: string[], startIndex: number): string[] {
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

/**
 * Get Parser instance (may be null if tree-sitter not available).
 */
export function getParser(): any {
    return Parser;
}

/**
 * Get the __dirname path for grammar loading.
 */
export function getGrammarDir(): string {
    return __dirname;
}
