/**
 * Ruby Language Adapter
 *
 * Handles Ruby-specific code analysis:
 * - Function extraction (def method_name with indent-based body)
 * - Import parsing (require, require_relative, gem)
 * - Error handling (rescue blocks)
 * - Naming conventions (snake_case methods, PascalCase classes)
 */

import { LanguageAdapter, FunctionFact, ImportFact, ErrorHandlerFact, NamingPattern, classifyCasing } from './types.js';

export class RubyAdapter implements LanguageAdapter {
    readonly id = 'ruby';
    readonly name = 'Ruby';
    readonly extensions = ['.rb', '.rake'];

    extractFunctions(source: string, filePath?: string): FunctionFact[] {
        const functions: FunctionFact[] = [];
        const lines = source.split('\n');

        // Match: def method_name(...) or def self.method_name(...)
        const defRegex = /^\s*def\s+(?:self\.)?(\w+)\s*(?:\(|$)/;

        for (let i = 0; i < lines.length; i++) {
            const match = lines[i].match(defRegex);
            if (!match) continue;

            const name = match[1];
            const startLine = i + 1;
            const baseIndent = lines[i].match(/^(\s*)/)?.[1]?.length || 0;
            const body: string[] = [];

            // Extract indent-based body until 'end' at same indent level
            for (let j = i + 1; j < lines.length; j++) {
                const currentLine = lines[j];
                if (currentLine.trim() === '') {
                    body.push(currentLine);
                    continue;
                }

                const currentIndent = currentLine.match(/^(\s*)/)?.[1]?.length || 0;
                if (currentIndent <= baseIndent && currentLine.trim() === 'end') {
                    break;
                }
                if (currentIndent <= baseIndent && currentLine.trim() !== '') {
                    break;
                }
                body.push(currentLine);
            }

            functions.push({
                name,
                startLine,
                endLine: startLine + body.length,
                body: body.join('\n'),
                isAsync: false,
                isExported: true, // Ruby doesn't have true exports; all methods accessible
            });
        }

        return functions;
    }

    extractImports(source: string): ImportFact[] {
        const imports: ImportFact[] = [];
        const lines = source.split('\n');

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();

            // require 'foo'
            let match = line.match(/^\s*require\s+['"]([^'"]+)['"]/);
            if (match) {
                imports.push({
                    module: match[1],
                    names: [],
                    line: i + 1,
                    isDynamic: false,
                });
                continue;
            }

            // require_relative 'foo'
            match = line.match(/^\s*require_relative\s+['"]([^'"]+)['"]/);
            if (match) {
                imports.push({
                    module: match[1],
                    names: [],
                    line: i + 1,
                    isDynamic: false,
                });
                continue;
            }

            // gem 'baz'
            match = line.match(/^\s*gem\s+['"]([^'"]+)['"]/);
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

            // Match: rescue ExceptionClass => var
            if (/^\s*rescue\s+/.test(line)) {
                const baseIndent = line.match(/^(\s*)/)?.[1]?.length || 0;
                const body: string[] = [];

                // Collect body until next rescue/else/ensure/end at same level
                for (let j = i + 1; j < lines.length; j++) {
                    const currentLine = lines[j];
                    if (currentLine.trim() === '') {
                        body.push(currentLine);
                        continue;
                    }

                    const currentIndent = currentLine.match(/^(\s*)/)?.[1]?.length || 0;
                    if (currentIndent <= baseIndent && /^\s*(?:rescue|else|ensure|end)\b/.test(currentLine)) {
                        break;
                    }
                    body.push(currentLine);
                }

                const bodyStr = body.join('\n');
                const strategy = this.classifyRubyStrategy(bodyStr);

                handlers.push({
                    type: 'rescue',
                    strategy,
                    startLine: i + 1,
                    body: bodyStr,
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

            // Method definitions
            let match = line.match(/^\s*def\s+(?:self\.)?(\w+)/);
            if (match) {
                const name = match[1];
                patterns.push({
                    name,
                    kind: 'method',
                    convention: classifyCasing(name),
                });
                continue;
            }

            // Class definitions
            match = line.match(/^\s*class\s+(\w+)/);
            if (match) {
                const name = match[1];
                patterns.push({
                    name,
                    kind: 'class',
                    convention: classifyCasing(name),
                });
                continue;
            }

            // Constant assignments
            match = line.match(/^\s*([A-Z_]\w*)\s*=/);
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
        // Remove line comments: #
        let result = source.replace(/#.*/g, '');
        // Remove block comments: =begin...=end
        result = result.replace(/^\s*=begin\b[\s\S]*?^\s*=end\b/m, '');
        return result;
    }

    extractComparisonOps(source: string): string[] {
        const ops: string[] = [];
        const cleaned = this.stripComments(source);

        const matches = cleaned.matchAll(/(===|==|!=|>=|<=|<=>|>(?!=)|<(?!=))/g);
        for (const m of matches) {
            ops.push(m[1]);
        }

        return ops;
    }

    countBranches(source: string): number {
        let count = 0;
        const cleaned = this.stripComments(source);

        count += (cleaned.match(/\bif\s+/g) || []).length;
        count += (cleaned.match(/\belsif\s+/g) || []).length;
        count += (cleaned.match(/\belse\b/g) || []).length;
        count += (cleaned.match(/\bunless\s+/g) || []).length;
        count += (cleaned.match(/\bcase\s+/g) || []).length;
        count += (cleaned.match(/\bwhen\s+/g) || []).length;

        return count;
    }

    countReturns(source: string): number {
        // Count explicit return statements
        return (source.match(/\breturn\b/g) || []).length;
    }

    private classifyRubyStrategy(body: string): string {
        const trimmed = body.trim();
        if (!trimmed) return 'swallow';
        if (/\braise\b/.test(trimmed)) return 'rethrow';
        if (/\breturn\s+nil\b/.test(trimmed)) return 'return-null';
        if (/\breturn\s+false\b/.test(trimmed)) return 'return-false';
        if (/\breturn\s+/.test(trimmed)) return 'return-value';
        if (/\bputs\b|\blogger\b|\bRails\.logger\b/i.test(trimmed)) return 'log';
        return 'other';
    }
}

export const rubyAdapter = new RubyAdapter();
