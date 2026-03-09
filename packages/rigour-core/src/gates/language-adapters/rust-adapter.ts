/**
 * Rust Language Adapter
 *
 * Handles Rust-specific code analysis:
 * - Function extraction (fn, pub fn, pub async fn)
 * - Import parsing (use statements)
 * - Error handling (match, unwrap_or_else)
 * - Naming conventions (snake_case functions, PascalCase types)
 */

import { LanguageAdapter, FunctionFact, ImportFact, ErrorHandlerFact, NamingPattern, classifyCasing } from './types.js';

export class RustAdapter implements LanguageAdapter {
    readonly id = 'rust';
    readonly name = 'Rust';
    readonly extensions = ['.rs'];

    extractFunctions(source: string, filePath?: string): FunctionFact[] {
        const functions: FunctionFact[] = [];
        const lines = source.split('\n');

        // Match: fn name(...), pub fn, pub async fn, impl blocks with methods
        const fnRegex = /^\s*(?:pub\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+(\w+)\s*\(/;

        for (let i = 0; i < lines.length; i++) {
            const match = lines[i].match(fnRegex);
            if (!match) continue;

            const name = match[1];
            const startLine = i + 1;
            const body = this.extractBraceBody(lines, i);
            const bodyStr = body.join('\n');

            const isAsync = /\basync\s+fn\b/.test(lines[i]);

            functions.push({
                name,
                startLine,
                endLine: startLine + body.length,
                body: bodyStr,
                isAsync,
                isExported: /\bpub\b/.test(lines[i]),
            });
        }

        return functions;
    }

    extractImports(source: string): ImportFact[] {
        const imports: ImportFact[] = [];
        const lines = source.split('\n');

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();

            // use std::foo;
            // use crate::bar;
            // extern crate baz;

            let match = line.match(/^\s*use\s+([\w:]+)(?:\s*::\s*\{([^}]+)\})?;/);
            if (match) {
                const module = match[1];
                const names = match[2] ? match[2].split(',').map(n => n.trim()) : [];
                imports.push({
                    module,
                    names,
                    line: i + 1,
                    isDynamic: false,
                });
                continue;
            }

            match = line.match(/^\s*extern\s+crate\s+(\w+);/);
            if (match) {
                imports.push({
                    module: match[1],
                    names: [],
                    line: i + 1,
                    isDynamic: false,
                });
            }
        }

        return imports;
    }

    extractErrorHandlers(source: string): ErrorHandlerFact[] {
        const handlers: ErrorHandlerFact[] = [];
        const lines = source.split('\n');

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            // Match: match result { Err(e) =>
            if (/match\s+/.test(line)) {
                const body = this.extractBraceBody(lines, i).join('\n');
                const strategy = this.classifyRustErrorStrategy(body);

                handlers.push({
                    type: 'match',
                    strategy,
                    startLine: i + 1,
                    body,
                });
                continue;
            }

            // Match: .unwrap_or_else(|e| ...)
            if (/\.unwrap_or_else\s*\(\s*\|/.test(line)) {
                const body = this.extractCallbackBody(lines, i);
                const strategy = this.classifyRustErrorStrategy(body);

                handlers.push({
                    type: 'unwrap_or_else',
                    strategy,
                    startLine: i + 1,
                    body,
                });
            }
        }

        return handlers;
    }

    extractNamingPatterns(source: string): NamingPattern[] {
        const patterns: NamingPattern[] = [];
        const lines = source.split('\n');

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            // Function definitions
            let match = line.match(/^\s*(?:pub\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+(\w+)/);
            if (match) {
                const name = match[1];
                patterns.push({
                    name,
                    kind: 'function',
                    convention: classifyCasing(name),
                });
                continue;
            }

            // Struct definitions
            match = line.match(/^\s*(?:pub\s+)?struct\s+(\w+)/);
            if (match) {
                const name = match[1];
                patterns.push({
                    name,
                    kind: 'class',
                    convention: classifyCasing(name),
                });
                continue;
            }

            // Enum definitions
            match = line.match(/^\s*(?:pub\s+)?enum\s+(\w+)/);
            if (match) {
                const name = match[1];
                patterns.push({
                    name,
                    kind: 'class',
                    convention: classifyCasing(name),
                });
                continue;
            }

            // Const declarations
            match = line.match(/^\s*(?:pub\s+)?const\s+(\w+)\s*:/);
            if (match) {
                const name = match[1];
                patterns.push({
                    name,
                    kind: 'constant',
                    convention: classifyCasing(name),
                });
            }
        }

        return patterns;
    }

    stripComments(source: string): string {
        // Remove line comments: //
        let result = source.replace(/\/\/.*/g, '');
        // Remove block comments: /* */
        result = result.replace(/\/\*[\s\S]*?\*\//g, '');
        return result;
    }

    extractComparisonOps(source: string): string[] {
        const ops: string[] = [];
        const cleaned = this.stripComments(source);

        const matches = cleaned.matchAll(/(==|!=|>=|<=|>(?!=)|<(?!=))/g);
        for (const m of matches) {
            ops.push(m[1]);
        }

        return ops;
    }

    countBranches(source: string): number {
        let count = 0;
        const cleaned = this.stripComments(source);

        count += (cleaned.match(/\bif\s+/g) || []).length;
        count += (cleaned.match(/\belse\s+if\s+/g) || []).length;
        count += (cleaned.match(/\belse\s*\{/g) || []).length;
        count += (cleaned.match(/\bmatch\s+/g) || []).length;
        count += (cleaned.match(/=>\s*/g) || []).length;

        return count;
    }

    countReturns(source: string): number {
        // Count explicit return + ? operator (early returns)
        let count = (source.match(/\breturn\b/g) || []).length;
        count += (source.match(/\?\s*(?:;|,|\))/g) || []).length;
        return count;
    }

    private extractBraceBody(lines: string[], startIndex: number): string[] {
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

    private extractCallbackBody(lines: string[], startIndex: number): string {
        // Extract the closure/callback body: |e| ...
        const line = lines[startIndex];
        const pipeStart = line.indexOf('|');
        const pipeEnd = line.indexOf('|', pipeStart + 1);

        if (pipeEnd === -1) {
            return line.substring(pipeStart);
        }

        // Body is after the second pipe
        return line.substring(pipeEnd + 1);
    }

    private classifyRustErrorStrategy(body: string): string {
        const trimmed = body.trim();
        if (!trimmed) return 'swallow';
        if (/\bpanic!\b|\?/.test(trimmed)) return 'rethrow';
        if (/\beprintln!\b|\blog::\w+\b/.test(trimmed)) return 'log';
        if (/\.map_err|map\s*\(/.test(trimmed)) return 'wrap';
        if (/\breturn\s+Err|Err\s*\(/.test(trimmed)) return 'return-error';
        if (/\bunwrap\b|\bexpect\b/.test(trimmed)) return 'unwrap';
        return 'other';
    }
}

export const rustAdapter = new RustAdapter();
