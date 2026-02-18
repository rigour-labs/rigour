/**
 * Helper utilities for promise-safety gate.
 * Extracted to keep promise-safety.ts under 500 lines.
 */

export interface PromiseViolation {
    file: string;
    line: number;
    type: 'unhandled-then' | 'unsafe-parse' | 'async-no-await' | 'unsafe-fetch' | 'ignored-error' | 'deadlock-risk' | 'bare-except';
    code: string;
    reason: string;
}

export function extractBraceBody(content: string, startIdx: number): string | null {
    let depth = 1;
    let idx = startIdx;
    while (depth > 0 && idx < content.length) {
        if (content[idx] === '{') depth++;
        if (content[idx] === '}') depth--;
        idx++;
    }
    return depth === 0 ? content.substring(startIdx, idx - 1) : null;
}

export function extractIndentedBody(content: string, startIdx: number): string | null {
    const rest = content.substring(startIdx);
    const lines = rest.split('\n');
    if (lines.length < 2) return null;

    let bodyIndent = -1;
    const bodyLines: string[] = [];

    for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (line.trim() === '' || line.trim().startsWith('#')) { bodyLines.push(line); continue; }
        const indent = line.length - line.trimStart().length;
        if (bodyIndent === -1) { bodyIndent = indent; }
        if (indent < bodyIndent) break;
        bodyLines.push(line);
    }
    return bodyLines.join('\n');
}

export function isInsideTryBlock(lines: string[], lineIdx: number): boolean {
    let braceDepth = 0;
    for (let j = lineIdx - 1; j >= Math.max(0, lineIdx - 30); j--) {
        const prevLine = stripStrings(lines[j]);
        for (const ch of prevLine) {
            if (ch === '}') braceDepth++;
            if (ch === '{') braceDepth--;
        }
        if (/\btry\s*\{/.test(prevLine) && braceDepth <= 0) return true;
        if (/\}\s*catch\s*\(/.test(prevLine)) return false;
    }
    return false;
}

export function isInsidePythonTry(lines: string[], lineIdx: number): boolean {
    const lineIndent = lines[lineIdx].length - lines[lineIdx].trimStart().length;
    for (let j = lineIdx - 1; j >= Math.max(0, lineIdx - 30); j--) {
        const trimmed = lines[j].trim();
        if (trimmed === '') continue;
        const indent = lines[j].length - lines[j].trimStart().length;
        if (indent < lineIndent && /^\s*try\s*:/.test(lines[j])) return true;
        if (indent < lineIndent && /^\s*(?:except|finally)\s*/.test(lines[j])) return false;
        if (indent === 0 && /^(?:def|class|async\s+def)\s/.test(trimmed)) break;
    }
    return false;
}

export function isInsideRubyRescue(lines: string[], lineIdx: number): boolean {
    for (let j = lineIdx - 1; j >= Math.max(0, lineIdx - 30); j--) {
        const trimmed = lines[j].trim();
        if (trimmed === 'begin') return true;
        if (/^rescue\b/.test(trimmed)) return false;
        if (/^(?:def|class|module)\s/.test(trimmed)) break;
    }
    return false;
}

export function hasCatchAhead(lines: string[], idx: number): boolean {
    for (let j = idx; j < Math.min(idx + 10, lines.length); j++) {
        if (/\.catch\s*\(/.test(lines[j])) return true;
    }
    return false;
}

export function hasStatusCheckAhead(lines: string[], idx: number): boolean {
    for (let j = idx; j < Math.min(idx + 10, lines.length); j++) {
        if (/\.\s*ok\b/.test(lines[j]) || /\.status(?:Text)?\b/.test(lines[j])) return true;
    }
    return false;
}

export function stripStrings(line: string): string {
    return line.replace(/`[^`]*`/g, '""').replace(/"[^"]*"/g, '""').replace(/'[^']*'/g, '""');
}
