/**
 * Pattern Indexer — Language-Specific Extractors
 *
 * Standalone extraction functions for Go, Rust, JVM (Java/Kotlin/C#),
 * Python, and a generic C-style fallback. Each function is pure and
 * receives all required context as parameters.
 */

import * as path from 'path';
import type { PatternEntry, PatternType } from './types.js';
import {
    createPatternEntry,
    extractKeywords,
    getCOMLineComments,
    getJavaDoc,
    findBraceBlockEnd,
    getBraceBlockContent,
} from './indexer-helpers.js';

// ---------------------------------------------------------------------------
// Go
// ---------------------------------------------------------------------------

export function extractGoPatterns(
    filePath: string,
    content: string,
    rootDir: string,
): PatternEntry[] {
    const patterns: PatternEntry[] = [];
    const relativePath = path.relative(rootDir, filePath);
    const lines = content.split('\n');

    const funcRegex = /^func\s+(?:\([^)]*\)\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*([^\{]*)\s*\{/;
    const typeRegex = /^type\s+([A-Za-z_][A-Za-z0-9_]*)\s+(struct|interface)/;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        const funcMatch = line.match(funcRegex);
        if (funcMatch) {
            const name = funcMatch[1];
            patterns.push(createPatternEntry({
                type: 'function',
                name,
                file: relativePath,
                line: i + 1,
                endLine: findBraceBlockEnd(lines, i),
                signature: `func ${name}(${funcMatch[2]}) ${funcMatch[3].trim()}`,
                description: getCOMLineComments(lines, i - 1),
                keywords: extractKeywords(name),
                content: getBraceBlockContent(lines, i),
                exported: /^[A-Z]/.test(name),
            }));
        }

        const typeMatch = line.match(typeRegex);
        if (typeMatch) {
            const name = typeMatch[1];
            patterns.push(createPatternEntry({
                type: typeMatch[2] as PatternType,
                name,
                file: relativePath,
                line: i + 1,
                endLine: findBraceBlockEnd(lines, i),
                signature: `type ${name} ${typeMatch[2]}`,
                description: getCOMLineComments(lines, i - 1),
                keywords: extractKeywords(name),
                content: getBraceBlockContent(lines, i),
                exported: /^[A-Z]/.test(name),
            }));
        }
    }
    return patterns;
}

// ---------------------------------------------------------------------------
// Rust
// ---------------------------------------------------------------------------

export function extractRustPatterns(
    filePath: string,
    content: string,
    rootDir: string,
): PatternEntry[] {
    const patterns: PatternEntry[] = [];
    const relativePath = path.relative(rootDir, filePath);
    const lines = content.split('\n');

    const fnRegex = /^(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)\s*[<(][^)]*[>)]\s*(?:->\s*[^\{]+)?\s*\{/;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        const fnMatch = line.match(fnRegex);
        if (fnMatch) {
            const name = fnMatch[1];
            patterns.push(createPatternEntry({
                type: 'function',
                name,
                file: relativePath,
                line: i + 1,
                endLine: findBraceBlockEnd(lines, i),
                signature: line.split('{')[0].trim(),
                description: getCOMLineComments(lines, i - 1),
                keywords: extractKeywords(name),
                content: getBraceBlockContent(lines, i),
                exported: line.startsWith('pub'),
            }));
        }
    }
    return patterns;
}

// ---------------------------------------------------------------------------
// JVM-style (Java, Kotlin, C#)
// ---------------------------------------------------------------------------

export function extractJVMStylePatterns(
    filePath: string,
    content: string,
    rootDir: string,
): PatternEntry[] {
    const patterns: PatternEntry[] = [];
    const relativePath = path.relative(rootDir, filePath);
    const lines = content.split('\n');

    const classRegex = /^(?:public|private|protected|internal)?\s*(?:static\s+)?(?:final\s+)?(?:class|interface|enum)\s+([A-Za-z0-9_]+)/;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();

        const classMatch = line.match(classRegex);
        if (classMatch) {
            patterns.push(createPatternEntry({
                type: 'class',
                name: classMatch[1],
                file: relativePath,
                line: i + 1,
                endLine: findBraceBlockEnd(lines, i),
                signature: line,
                description: getJavaDoc(lines, i - 1),
                keywords: extractKeywords(classMatch[1]),
                content: getBraceBlockContent(lines, i),
                exported: line.includes('public'),
            }));
        }
    }
    return patterns;
}

// ---------------------------------------------------------------------------
// Generic C-style fallback (C++, PHP, etc.)
// ---------------------------------------------------------------------------

export function extractGenericCPatterns(
    _filePath: string,
    _content: string,
): PatternEntry[] {
    return [];
}

// ---------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------

export function extractPythonPatterns(
    filePath: string,
    content: string,
    rootDir: string,
    minNameLength: number,
): PatternEntry[] {
    const patterns: PatternEntry[] = [];
    const relativePath = path.relative(rootDir, filePath);
    const lines = content.split('\n');

    const classRegex = /^class\s+([A-Za-z_][A-Za-z0-9_]*)\s*(\([^)]*\))?\s*:/;
    const funcRegex = /^(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*(?:->\s*[^:]+)?\s*:/;
    const constRegex = /^([A-Z][A-Z0-9_]*)\s*=\s*(.+)$/;

    for (let i = 0; i < lines.length; i++) {
        const originalLine = lines[i];
        const lineNum = i + 1;

        const classMatch = originalLine.match(classRegex);
        if (classMatch) {
            const name = classMatch[1];
            if (name.length >= minNameLength) {
                patterns.push(createPatternEntry({
                    type: detectPythonClassType(name),
                    name,
                    file: relativePath,
                    line: lineNum,
                    endLine: findPythonBlockEnd(lines, i),
                    signature: `class ${name}${classMatch[2] || ''}`,
                    description: getPythonDocstring(lines, i + 1),
                    keywords: extractKeywords(name),
                    content: getPythonBlockContent(lines, i),
                    exported: !name.startsWith('_'),
                }));
                continue;
            }
        }

        const funcMatch = originalLine.match(funcRegex);
        if (funcMatch) {
            const name = funcMatch[1];
            if (name.length >= minNameLength) {
                patterns.push(createPatternEntry({
                    type: detectPythonFunctionType(name),
                    name,
                    file: relativePath,
                    line: lineNum,
                    endLine: findPythonBlockEnd(lines, i),
                    signature: `def ${name}(${funcMatch[2]})`,
                    description: getPythonDocstring(lines, i + 1),
                    keywords: extractKeywords(name),
                    content: getPythonBlockContent(lines, i),
                    exported: !name.startsWith('_'),
                }));
                continue;
            }
        }

        const constMatch = originalLine.match(constRegex);
        if (constMatch) {
            const name = constMatch[1];
            if (name.length >= minNameLength) {
                patterns.push(createPatternEntry({
                    type: 'constant',
                    name,
                    file: relativePath,
                    line: lineNum,
                    endLine: lineNum,
                    signature: `${name} = ...`,
                    description: '',
                    keywords: extractKeywords(name),
                    content: originalLine,
                    exported: !name.startsWith('_'),
                }));
            }
        }
    }

    return patterns;
}

// ---------------------------------------------------------------------------
// Python helpers (private to this module)
// ---------------------------------------------------------------------------

function detectPythonClassType(name: string): PatternType {
    if (name.endsWith('Error') || name.endsWith('Exception')) return 'error';
    if (name.endsWith('Model')) return 'model';
    if (name.endsWith('Schema')) return 'schema';
    return 'class';
}

function detectPythonFunctionType(name: string): PatternType {
    if (name.includes('middleware')) return 'middleware';
    if (name.includes('handler')) return 'handler';
    return 'function';
}

function getPythonDocstring(lines: string[], startIndex: number): string {
    if (startIndex >= lines.length) return '';
    const nextLine = lines[startIndex].trim();
    if (nextLine.startsWith('"""') || nextLine.startsWith("'''")) {
        const quote = nextLine.startsWith('"""') ? '"""' : "'''";
        let doc = nextLine.replace(quote, '');
        if (doc.endsWith(quote)) return doc.replace(quote, '').trim();

        for (let i = startIndex + 1; i < lines.length; i++) {
            if (lines[i].includes(quote)) {
                doc += ' ' + lines[i].split(quote)[0].trim();
                break;
            }
            doc += ' ' + lines[i].trim();
        }
        return doc.trim();
    }
    return '';
}

function findPythonBlockEnd(lines: string[], startIndex: number): number {
    const startIndent = lines[startIndex].search(/\S/);
    for (let i = startIndex + 1; i < lines.length; i++) {
        if (lines[i].trim() === '') continue;
        const currentIndent = lines[i].search(/\S/);
        if (currentIndent <= startIndent) return i;
    }
    return lines.length;
}

function getPythonBlockContent(lines: string[], startIndex: number): string {
    const endLine = findPythonBlockEnd(lines, startIndex);
    return lines.slice(startIndex, endLine).join('\n');
}
