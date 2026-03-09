/**
 * JavaScript/TypeScript Language Adapter
 *
 * Handles: .ts, .tsx, .js, .jsx, .mjs, .cjs
 *
 * Regex-based static analysis for JS/TS code patterns.
 */

import type { LanguageAdapter, FunctionFact, ImportFact, ErrorHandlerFact, NamingPattern } from './types.js';
import { classifyCasing } from './types.js';

class JsAdapter implements LanguageAdapter {
    readonly id = 'js';
    readonly name = 'JavaScript/TypeScript';
    readonly extensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

    extractFunctions(source: string, filePath?: string): FunctionFact[] {
        const functions: FunctionFact[] = [];
        const lines = source.split('\n');

        // Match: function foo() { ... }, async function foo() { ... }
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            // Traditional function declaration
            let match = line.match(/(?:^|\s)(async\s+)?function\s+(\w+)\s*\(/);
            if (match) {
                const isAsync = !!match[1];
                const name = match[2];
                const body = this.extractBraceBody(lines, i);
                const endLine = i + body.length;
                const isExported = /\bexport\b/.test(lines.slice(Math.max(0, i - 2), i + 1).join(' '));

                functions.push({
                    name, startLine: i + 1, endLine: endLine + 1,
                    body: body.join('\n'), isAsync, isExported,
                });
            }

            // Arrow function: const foo = () => { ... }
            match = line.match(/(?:const|let|var)\s+(\w+)\s*=\s*(async\s+)?\([^)]*\)\s*=>\s*\{/);
            if (match) {
                const name = match[1];
                const isAsync = !!match[2];
                const body = this.extractBraceBody(lines, i);
                const endLine = i + body.length;
                const isExported = /\bexport\b/.test(lines.slice(Math.max(0, i - 2), i + 1).join(' '));

                functions.push({
                    name, startLine: i + 1, endLine: endLine + 1,
                    body: body.join('\n'), isAsync, isExported,
                });
            }

            // Export function: export function foo() { ... }
            match = line.match(/\bexport\s+(?:async\s+)?function\s+(\w+)\s*\(/);
            if (match) {
                const name = match[1];
                const isAsync = /\basync\b/.test(line);
                const body = this.extractBraceBody(lines, i);
                const endLine = i + body.length;

                functions.push({
                    name, startLine: i + 1, endLine: endLine + 1,
                    body: body.join('\n'), isAsync, isExported: true,
                });
            }

            // Class method: methodName() { ... }
            match = line.match(/^\s*(?:async\s+)?(\w+)\s*\([^)]*\)\s*\{/);
            if (match && i > 0) {
                const prevLine = lines[i - 1];
                if (/\bclass\s+\w+/.test(prevLine) || /^\s+constructor\s*\(/.test(line) || !prevLine.includes('function')) {
                    const name = match[1];
                    const isAsync = /\basync\b/.test(line);
                    const body = this.extractBraceBody(lines, i);
                    const endLine = i + body.length;

                    functions.push({
                        name, startLine: i + 1, endLine: endLine + 1,
                        body: body.join('\n'), isAsync, isExported: false,
                    });
                }
            }
        }

        return functions;
    }

    extractImports(source: string): ImportFact[] {
        const imports: ImportFact[] = [];
        const lines = source.split('\n');

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            // import x from 'module'
            let match = line.match(/^\s*import\s+(?:\{([^}]+)\}|(\w+)|(\*\s+as\s+(\w+)))\s+from\s+['"]([^'"]+)['"]/);
            if (match) {
                const names = match[1] ? match[1].split(',').map(s => s.trim()) : (match[4] ? [match[4]] : (match[2] ? [match[2]] : []));
                imports.push({
                    module: match[5], names, line: i + 1, isDynamic: false,
                });
            }

            // require('module')
            match = line.match(/(?:const|let|var)\s+(?:\{([^}]+)\}|(\w+))\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/);
            if (match) {
                const names = match[1] ? match[1].split(',').map(s => s.trim()) : [match[2]];
                imports.push({
                    module: match[3], names, line: i + 1, isDynamic: false,
                });
            }

            // import('module') - dynamic
            match = line.match(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/);
            if (match) {
                imports.push({
                    module: match[1], names: [], line: i + 1, isDynamic: true,
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

            // try { ... } catch (e) { ... }
            if (/\btry\s*\{/.test(line)) {
                for (let j = i + 1; j < lines.length; j++) {
                    if (/\bcatch\s*\(/.test(lines[j])) {
                        const body = this.extractBraceBody(lines, j);
                        const strategy = this.classifyJsErrorStrategy(body.join('\n'));
                        handlers.push({
                            type: 'try-catch', strategy,
                            startLine: j + 1, body: body.join('\n'),
                        });
                        break;
                    }
                }
            }

            // .catch(e => { ... })
            if (/\.catch\s*\(/.test(line)) {
                const body = this.extractCatchCallbackBody(lines, i);
                if (body) {
                    const strategy = this.classifyJsErrorStrategy(body);
                    handlers.push({
                        type: 'try-catch', strategy,
                        startLine: i + 1, body,
                    });
                }
            }
        }

        return handlers;
    }

    extractNamingPatterns(source: string): NamingPattern[] {
        const patterns: NamingPattern[] = [];
        const lines = source.split('\n');

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            // function foo() { ... }
            let match = line.match(/\bfunction\s+(\w+)\s*\(/);
            if (match) {
                patterns.push({
                    name: match[1], kind: 'function',
                    convention: classifyCasing(match[1]),
                });
            }

            // class Foo { ... }
            match = line.match(/\bclass\s+(\w+)/);
            if (match) {
                patterns.push({
                    name: match[1], kind: 'class',
                    convention: classifyCasing(match[1]),
                });
            }

            // const foo = ..., let foo = ..., var foo = ...
            match = line.match(/(?:const|let|var)\s+(\w+)\s*=/);
            if (match && !line.includes('function')) {
                const isFunctionExpr = /=\s*(?:async\s+)?\(/.test(line) || /=>\s*/.test(line);
                const kind = isFunctionExpr ? 'function' : 'variable';
                patterns.push({
                    name: match[1], kind,
                    convention: classifyCasing(match[1]),
                });
            }

            // Method names in classes
            match = line.match(/^\s+(\w+)\s*\([^)]*\)\s*\{/);
            if (match && /\bclass\b/.test(lines.slice(Math.max(0, i - 10), i).join(' '))) {
                patterns.push({
                    name: match[1], kind: 'method',
                    convention: classifyCasing(match[1]),
                });
            }
        }

        return patterns;
    }

    stripComments(source: string): string {
        // Remove line comments
        let result = source.replace(/\/\/.*/g, '');
        // Remove block comments
        result = result.replace(/\/\*[\s\S]*?\*\//g, '');
        return result;
    }

    extractComparisonOps(source: string): string[] {
        const ops: string[] = [];
        const cleaned = this.stripComments(source);
        const matches = cleaned.matchAll(/(===|!==|==|!=|>=|<=|>(?!=)|<(?!=))/g);
        for (const m of matches) {
            ops.push(m[1]);
        }
        return ops;
    }

    countBranches(source: string): number {
        let count = 0;
        const cleaned = this.stripComments(source);
        count += (cleaned.match(/\bif\s*\(/g) || []).length;
        count += (cleaned.match(/\belse\s+if\s*\(/g) || []).length;
        count += (cleaned.match(/\belse\s*\{/g) || []).length;
        count += (cleaned.match(/\bswitch\s*\(/g) || []).length;
        count += (cleaned.match(/\bcase\s+/g) || []).length;
        count += (cleaned.match(/\?\s*[^?]/g) || []).length;
        return count;
    }

    countReturns(source: string): number {
        return (source.match(/\breturn\b/g) || []).length;
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

    private extractCatchCallbackBody(lines: string[], startLine: number): string | null {
        const hasArrow = lines[startLine]?.includes('=>');
        let depth = 0;
        let started = false;
        const body: string[] = [];

        for (let i = startLine; i < Math.min(startLine + 20, lines.length); i++) {
            for (const ch of lines[i]) {
                if (hasArrow) {
                    if (ch === '{') { depth++; started = true; }
                    if (ch === '}') depth--;
                } else {
                    if (ch === '{' || ch === '(') { depth++; started = true; }
                    if (ch === '}' || ch === ')') depth--;
                }
            }
            if (started && i > startLine) body.push(lines[i]);
            if (started && depth <= 0) break;
        }

        return body.length > 0 ? body.join('\n') : null;
    }

    private classifyJsErrorStrategy(body: string): string {
        const trimmed = body.trim();
        if (!trimmed || trimmed === '{}') return 'swallow';
        if (/\bthrow\b/.test(trimmed)) {
            if (/\bthrow\s+new\b/.test(trimmed)) return 'wrap';
            return 'rethrow';
        }
        if (/\breturn\s+null\b|\breturn\s+undefined\b|\breturn\s*;/.test(trimmed)) return 'return-error';
        if (/console\.(error|warn|log)\b/.test(trimmed)) return 'log';
        return 'other';
    }
}

export const jsAdapter = new JsAdapter();
