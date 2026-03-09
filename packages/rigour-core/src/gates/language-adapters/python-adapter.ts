/**
 * Python Language Adapter
 *
 * Handles: .py, .pyw
 *
 * Regex-based static analysis for Python code patterns.
 */

import type { LanguageAdapter, FunctionFact, ImportFact, ErrorHandlerFact, NamingPattern } from './types.js';
import { classifyCasing } from './types.js';

class PythonAdapter implements LanguageAdapter {
    readonly id = 'python';
    readonly name = 'Python';
    readonly extensions = ['.py', '.pyw'];

    extractFunctions(source: string, filePath?: string): FunctionFact[] {
        const functions: FunctionFact[] = [];
        const lines = source.split('\n');

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            // def foo(...): or async def foo(...):
            const match = line.match(/^\s*(async\s+)?def\s+(\w+)\s*\(/);
            if (match) {
                const isAsync = !!match[1];
                const name = match[2];
                const body = this.extractIndentBody(lines, i);
                const endLine = i + body.length;
                const isExported = false; // Python doesn't have explicit exports in the traditional sense

                functions.push({
                    name, startLine: i + 1, endLine: endLine + 1,
                    body: body.join('\n'), isAsync, isExported,
                });
            }
        }

        return functions;
    }

    extractImports(source: string): ImportFact[] {
        const imports: ImportFact[] = [];
        const lines = source.split('\n');

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            // import x or import x as y
            let match = line.match(/^\s*import\s+([\w.]+)(?:\s+as\s+(\w+))?/);
            if (match) {
                const names = match[2] ? [match[2]] : [match[1]];
                imports.push({
                    module: match[1], names, line: i + 1, isDynamic: false,
                });
            }

            // from x import y, z
            match = line.match(/^\s*from\s+([\w.]+)\s+import\s+(.+)/);
            if (match) {
                const names = match[2]
                    .split(',')
                    .map(s => s.trim())
                    .filter(s => s && s !== '*');
                imports.push({
                    module: match[1], names: names.length > 0 ? names : [], line: i + 1, isDynamic: false,
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

            // except ExceptionType as e:  OR  bare except:
            const match = line.match(/^\s*except\s*(?:(\w[\w.]*)(?:\s+as\s+(\w+))?)?\s*:/);
            if (match) {
                const body = this.extractIndentBody(lines, i);
                const exceptionType = match[1] || null; // null = bare except
                const strategy = this.classifyPythonErrorStrategy(body.join('\n'), exceptionType);
                handlers.push({
                    type: exceptionType ? 'except' : 'bare-except',
                    strategy,
                    startLine: i + 1, body: body.join('\n'),
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

            // def foo(...):
            let match = line.match(/^\s*def\s+(\w+)\s*\(/);
            if (match) {
                patterns.push({
                    name: match[1], kind: 'function',
                    convention: classifyCasing(match[1]),
                });
            }

            // class Foo:
            match = line.match(/^\s*class\s+(\w+)/);
            if (match) {
                patterns.push({
                    name: match[1], kind: 'class',
                    convention: classifyCasing(match[1]),
                });
            }

            // foo = ... (variable assignment at module level)
            match = line.match(/^(\w+)\s*=/);
            if (match && !line.includes('def') && !line.includes('class')) {
                const name = match[1];
                // Distinguish constants from regular variables
                const kind = /^[A-Z][A-Z0-9_]*$/.test(name) ? 'constant' : 'variable';
                patterns.push({
                    name, kind,
                    convention: classifyCasing(name),
                });
            }
        }

        return patterns;
    }

    stripComments(source: string): string {
        // Remove line comments (#)
        let result = source.replace(/#.*/g, '');
        // Remove docstrings (""" or ''')
        result = result.replace(/"""[\s\S]*?"""/g, '');
        result = result.replace(/'''[\s\S]*?'''/g, '');
        return result;
    }

    extractComparisonOps(source: string): string[] {
        const ops: string[] = [];
        const cleaned = this.stripComments(source);
        const matches = cleaned.matchAll(/(==|!=|>=|<=|>(?!=)|<(?!=)|\bis\s+not\b|\bis\b|\bnot\s+in\b|\bin\b)/g);
        for (const m of matches) {
            ops.push(m[1].trim());
        }
        return ops;
    }

    countBranches(source: string): number {
        let count = 0;
        const cleaned = this.stripComments(source);
        count += (cleaned.match(/\bif\s+/g) || []).length;
        count += (cleaned.match(/\belif\s+/g) || []).length;
        count += (cleaned.match(/\belse\s*:/g) || []).length;
        count += (cleaned.match(/\bmatch\s+/g) || []).length;
        count += (cleaned.match(/\bcase\s+/g) || []).length;
        return count;
    }

    countReturns(source: string): number {
        return (source.match(/\breturn\b/g) || []).length;
    }

    private extractIndentBody(lines: string[], startIndex: number): string[] {
        const body: string[] = [];
        const defLine = lines[startIndex];
        const defIndent = defLine.match(/^(\s*)/)?.[1]?.length || 0;

        for (let i = startIndex + 1; i < lines.length; i++) {
            const line = lines[i];
            if (line.trim() === '') {
                body.push(line);
                continue;
            }
            const currentIndent = line.match(/^(\s*)/)?.[1]?.length || 0;
            if (currentIndent <= defIndent) break;
            body.push(line);
        }

        return body;
    }

    private classifyPythonErrorStrategy(body: string, exceptionType: string | null): string {
        const trimmed = body.trim();
        // Bare except with just pass/... is always a swallow anti-pattern
        if (!trimmed || trimmed === 'pass' || trimmed === '...') return 'swallow';
        // `except Exception: pass` is also a swallow (catches everything, does nothing useful)
        if (exceptionType === 'Exception' && (trimmed === 'pass' || trimmed === '...' || !trimmed)) return 'swallow';
        if (/\braise\b/.test(trimmed)) {
            if (/\braise\s+\w+Error\b/.test(trimmed)) return 'wrap';
            return 'rethrow';
        }
        if (/\breturn\s+None\b|\breturn\s*$/.test(trimmed)) return 'return-error';
        if (/\blogging\.\w+|\blogger\.\w+|\bprint\s*\(/.test(trimmed)) return 'log';
        return 'other';
    }
}

export const pythonAdapter = new PythonAdapter();
