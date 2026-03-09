import { SideEffectLang, stripStrings } from './types.js';

// ═══════════════════════════════════════════════════════════════════
// SCOPE ANALYSIS — Find function/block boundaries
// ═══════════════════════════════════════════════════════════════════

/**
 * Find the enclosing function scope for a given line.
 * Returns { start, end } of the function body.
 * For module-level code, returns { start: 0, end: lines.length }.
 *
 * Follows promise-safety's approach of backward scanning with brace tracking.
 */
export function findEnclosingFunction(
    lines: string[], lineIdx: number, lang: SideEffectLang,
): { start: number; end: number } {
    if (lang === 'py') return findEnclosingFunctionPython(lines, lineIdx);
    if (lang === 'rb') return findEnclosingFunctionRuby(lines, lineIdx);
    return findEnclosingFunctionBrace(lines, lineIdx, lang);
}

function findEnclosingFunctionBrace(
    lines: string[], lineIdx: number, lang: SideEffectLang,
): { start: number; end: number } {
    // Walk backwards tracking brace depth to find function definition
    let braceDepth = 0;
    const funcPatterns = getFunctionPatterns(lang);

    for (let j = lineIdx; j >= Math.max(0, lineIdx - 200); j--) {
        const stripped = stripStrings(lines[j]);
        // Count braces (reverse direction: } increases, { decreases)
        for (const ch of stripped) {
            if (ch === '}') braceDepth++;
            if (ch === '{') braceDepth--;
        }

        // If braceDepth < 0, we've exited the enclosing block going backwards
        if (braceDepth < 0) {
            // Check if this line is a function definition
            for (const pat of funcPatterns) {
                if (pat.test(stripped)) {
                    const end = findBlockEndBrace(lines, j);
                    return { start: j, end };
                }
            }
            // It's some other block (if/for/etc), keep looking
            braceDepth = 0;
        }
    }

    // Module level
    return { start: 0, end: lines.length };
}

function findEnclosingFunctionPython(
    lines: string[], lineIdx: number,
): { start: number; end: number } {
    const lineIndent = lines[lineIdx].length - lines[lineIdx].trimStart().length;
    for (let j = lineIdx - 1; j >= 0; j--) {
        const trimmed = lines[j].trim();
        if (trimmed === '' || trimmed.startsWith('#')) continue;
        const indent = lines[j].length - lines[j].trimStart().length;
        if (indent < lineIndent && /^\s*(?:async\s+)?def\s+\w+/.test(lines[j])) {
            const end = findBlockEndIndent(lines, j);
            return { start: j, end };
        }
        if (indent === 0 && /^\s*(?:class|def|async\s+def)\s/.test(lines[j])) {
            const end = findBlockEndIndent(lines, j);
            return { start: j, end };
        }
    }
    return { start: 0, end: lines.length };
}

function findEnclosingFunctionRuby(
    lines: string[], lineIdx: number,
): { start: number; end: number } {
    for (let j = lineIdx - 1; j >= Math.max(0, lineIdx - 100); j--) {
        const trimmed = lines[j].trim();
        if (/^def\s+\w+/.test(trimmed)) {
            const end = findBlockEndRuby(lines, j);
            return { start: j, end };
        }
    }
    return { start: 0, end: lines.length };
}

/**
 * Find the end of a brace-delimited block starting at `start`.
 */
export function findBlockEndBrace(lines: string[], start: number): number {
    let braces = 0;
    let started = false;
    const maxScan = Math.min(lines.length, start + 300);
    for (let j = start; j < maxScan; j++) {
        const stripped = stripStrings(lines[j]);
        for (const ch of stripped) {
            if (ch === '{') { braces++; started = true; }
            if (ch === '}') braces--;
        }
        if (started && braces <= 0) return j + 1;
    }
    return maxScan;
}

/**
 * Find the end of an indentation-delimited block (Python).
 */
export function findBlockEndIndent(lines: string[], start: number): number {
    const baseIndent = lines[start].length - lines[start].trimStart().length;
    const maxScan = Math.min(lines.length, start + 300);
    for (let j = start + 1; j < maxScan; j++) {
        const trimmed = lines[j].trim();
        if (trimmed === '' || trimmed.startsWith('#')) continue;
        const indent = lines[j].length - lines[j].trimStart().length;
        if (indent <= baseIndent) return j;
    }
    return maxScan;
}

function findBlockEndRuby(lines: string[], start: number): number {
    let depth = 0;
    const maxScan = Math.min(lines.length, start + 300);
    const openers = /\b(?:def|do|class|module|if|unless|while|until|for|begin|case)\b/;
    for (let j = start; j < maxScan; j++) {
        const trimmed = lines[j].trim();
        if (openers.test(trimmed)) depth++;
        if (/^\s*end\b/.test(trimmed)) {
            depth--;
            if (depth <= 0) return j + 1;
        }
    }
    return maxScan;
}

export function getFunctionPatterns(lang: SideEffectLang): RegExp[] {
    switch (lang) {
        case 'go':
            return [/\bfunc\s+/];
        case 'rs':
            return [/\bfn\s+\w+/];
        case 'java':
        case 'cs':
            return [/(?:public|private|protected|static|async|void|int|string|Task|var)\s+\w+\s*\(/];
        default: // js, ts
            return [
                /(?:export\s+)?(?:async\s+)?function\s+\w+/,
                /(?:const|let|var)\s+\w+\s*=\s*(?:async\s+)?(?:\([^)]*\)|[^=])\s*=>/,
                /\w+\s*\([^)]*\)\s*\{/,   // method shorthand
            ];
    }
}
