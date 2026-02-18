/**
 * Pattern Indexer — Pure Utility Helpers
 *
 * Standalone pure functions shared across language extractors and the main
 * indexer class. No class state is referenced here.
 */

import { createHash } from 'crypto';
import type { PatternEntry, PatternType } from './types.js';

// ---------------------------------------------------------------------------
// Hashing / ID generation
// ---------------------------------------------------------------------------

/** SHA-256 of `content`, truncated to 16 hex chars. */
export function hashContent(content: string): string {
    return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// Pattern entry construction
// ---------------------------------------------------------------------------

export interface PatternEntryParams {
    type: PatternType;
    name: string;
    file: string;
    line: number;
    endLine: number;
    signature: string;
    description: string;
    keywords: string[];
    content: string;
    exported: boolean;
}

/** Build a complete PatternEntry from constituent parts. */
export function createPatternEntry(params: PatternEntryParams): PatternEntry {
    const id = hashContent(`${params.file}:${params.name}:${params.line}`);
    const hash = hashContent(params.content);

    return {
        id,
        type: params.type,
        name: params.name,
        file: params.file,
        line: params.line,
        endLine: params.endLine,
        signature: params.signature,
        description: params.description,
        keywords: params.keywords,
        hash,
        exported: params.exported,
        usageCount: 0,
        indexedAt: new Date().toISOString(),
    };
}

// ---------------------------------------------------------------------------
// Keyword extraction
// ---------------------------------------------------------------------------

/** Split camelCase / PascalCase / snake_case names into unique lowercase words. */
export function extractKeywords(name: string): string[] {
    const words = name
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
        .toLowerCase()
        .split(/[\s_-]+/)
        .filter(w => w.length > 1);

    return [...new Set(words)];
}

// ---------------------------------------------------------------------------
// Brace-based block helpers (Go, Rust, JVM, C-style)
// ---------------------------------------------------------------------------

/** Walk forward from `startIndex` and return the line index after the closing brace. */
export function findBraceBlockEnd(lines: string[], startIndex: number): number {
    let braceCount = 0;
    let started = false;
    for (let i = startIndex; i < lines.length; i++) {
        const line = lines[i];
        if (line.includes('{')) {
            braceCount += (line.match(/\{/g) || []).length;
            started = true;
        }
        if (line.includes('}')) {
            braceCount -= (line.match(/\}/g) || []).length;
        }
        if (started && braceCount === 0) return i + 1;
    }
    return lines.length;
}

/** Return the source lines for a brace-delimited block starting at `startIndex`. */
export function getBraceBlockContent(lines: string[], startIndex: number): string {
    const end = findBraceBlockEnd(lines, startIndex);
    return lines.slice(startIndex, end).join('\n');
}

// ---------------------------------------------------------------------------
// Comment extraction helpers
// ---------------------------------------------------------------------------

/**
 * Collect consecutive `//` comments immediately above `startIndex` (Go / Rust style).
 * Walks upward until a non-comment line is encountered.
 */
export function getCOMLineComments(lines: string[], startIndex: number): string {
    const comments: string[] = [];
    for (let i = startIndex; i >= 0; i--) {
        const line = lines[i].trim();
        if (line.startsWith('//')) {
            comments.unshift(line.replace('//', '').trim());
        } else {
            break;
        }
    }
    return comments.join(' ');
}

/**
 * Extract the first JavaDoc `/** … *\/` comment block found above `startIndex`.
 */
export function getJavaDoc(lines: string[], startIndex: number): string {
    const comments: string[] = [];
    let inDoc = false;
    for (let i = startIndex; i >= 0; i--) {
        const line = lines[i].trim();
        if (line.endsWith('*/')) inDoc = true;
        if (inDoc) {
            comments.unshift(
                line.replace('/**', '').replace('*/', '').replace(/^\*/, '').trim()
            );
        }
        if (line.startsWith('/**')) break;
    }
    return comments.join(' ');
}
