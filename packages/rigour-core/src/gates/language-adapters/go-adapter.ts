/**
 * Go Language Adapter
 *
 * Handles Go-specific code analysis:
 * - Function extraction (func Name, func (r *Receiver) Name)
 * - Import parsing (single and multiline blocks)
 * - Error handling (if err != nil patterns)
 * - Naming conventions (PascalCase exports, camelCase unexported)
 */

import { LanguageAdapter, FunctionFact, ImportFact, ErrorHandlerFact, NamingPattern, classifyCasing } from './types.js';

export class GoAdapter implements LanguageAdapter {
    readonly id = 'go';
    readonly name = 'Go';
    readonly extensions = ['.go'];

    extractFunctions(source: string, filePath?: string): FunctionFact[] {
        const functions: FunctionFact[] = [];
        const lines = source.split('\n');

        // Match: func Name(...) or func (r *Receiver) Name(...)
        const funcRegex = /^\s*func\s+(?:\([^)]+\)\s+)?(\w+)\s*\(/;

        for (let i = 0; i < lines.length; i++) {
            const match = lines[i].match(funcRegex);
            if (!match) continue;

            const name = match[1];
            const startLine = i + 1;
            const body = this.extractBraceBody(lines, i);
            const bodyStr = body.join('\n');

            functions.push({
                name,
                startLine,
                endLine: startLine + body.length,
                body: bodyStr,
                isAsync: false,
                isExported: /^[A-Z]/.test(name),
            });
        }

        return functions;
    }

    extractImports(source: string): ImportFact[] {
        const imports: ImportFact[] = [];
        const lines = source.split('\n');

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();

            // Single import: import "pkg"
            const singleMatch = line.match(/^\s*import\s+"([^"]+)"/);
            if (singleMatch) {
                imports.push({
                    module: singleMatch[1],
                    names: [],
                    line: i + 1,
                    isDynamic: false,
                });
                continue;
            }

            // Multiline import block: import ( "pkg1" "pkg2" )
            if (line.startsWith('import') && line.includes('(')) {
                let j = i;
                while (j < lines.length && !lines[j].includes(')')) {
                    j++;
                }

                for (let k = i + 1; k < j; k++) {
                    const importLine = lines[k].trim();
                    if (importLine.startsWith('//')) continue;
                    const pkgMatch = importLine.match(/"([^"]+)"/);
                    if (pkgMatch) {
                        imports.push({
                            module: pkgMatch[1],
                            names: [],
                            line: k + 1,
                            isDynamic: false,
                        });
                    }
                }
                i = j;
            }
        }

        return imports;
    }

    extractErrorHandlers(source: string): ErrorHandlerFact[] {
        const handlers: ErrorHandlerFact[] = [];
        const lines = source.split('\n');

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            // Match: if err != nil {
            if (/if\s+err\s*!=\s*nil\s*\{/.test(line)) {
                const body = this.extractBraceBody(lines, i).join('\n');
                const strategy = this.classifyGoErrorStrategy(body);

                handlers.push({
                    type: 'if-err',
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
            const funcMatch = line.match(/^\s*func\s+(?:\([^)]+\)\s+)?(\w+)\s*\(/);
            if (funcMatch) {
                const name = funcMatch[1];
                patterns.push({
                    name,
                    kind: 'function',
                    convention: classifyCasing(name),
                });
                continue;
            }

            // Const/var declarations
            const varMatch = line.match(/^\s*(?:const|var)\s+(\w+)\s*=/);
            if (varMatch) {
                const name = varMatch[1];
                const kind = line.includes('const') ? 'constant' : 'variable';
                patterns.push({
                    name,
                    kind,
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

        const matches = cleaned.matchAll(/(===|!==|==|!=|>=|<=|>(?!=)|<(?!=))/g);
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
        count += (cleaned.match(/\bswitch\s/g) || []).length;
        count += (cleaned.match(/\bcase\s+/g) || []).length;
        count += (cleaned.match(/\bselect\s*\{/g) || []).length;

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

    private classifyGoErrorStrategy(body: string): string {
        const trimmed = body.trim();
        if (!trimmed) return 'swallow';
        if (/\breturn\b.*\berr\b/.test(trimmed)) return 'return-error';
        if (/\breturn\b.*fmt\.Errorf|errors\.Wrap/.test(trimmed)) return 'wrap';
        if (/\bpanic\b/.test(trimmed)) return 'panic';
        if (/\blog\b/.test(trimmed)) return 'log';
        return 'other';
    }
}

export const goAdapter = new GoAdapter();
