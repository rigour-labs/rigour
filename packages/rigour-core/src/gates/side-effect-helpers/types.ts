/**
 * Side-Effect Analysis Helpers
 *
 * Context-aware utilities for smart side-effect detection.
 * Follows the same architectural patterns as promise-safety-helpers.ts:
 *   - Scope-aware analysis (brace/indent tracking)
 *   - Variable binding tracking (pair resource creation with cleanup)
 *   - Framework detection (React useEffect, Go defer, Python with, etc.)
 *   - Path overlap analysis (circular file watcher detection)
 *
 * These helpers make side-effect detection SMART — instead of asking
 * "does clearInterval exist anywhere in the file?", we ask
 * "is the specific timer variable cleaned up in the right scope?"
 */

export type SideEffectLang = 'js' | 'ts' | 'py' | 'go' | 'rs' | 'cs' | 'java' | 'rb';

export interface SideEffectViolation {
    rule: string;
    severity: 'critical' | 'high' | 'medium' | 'low';
    file: string;
    line: number;
    match: string;
    description: string;
    hint: string;
}

/**
 * Tracks a resource creation and its expected cleanup.
 * E.g.: { varName: 'timer', createLine: 5, createCall: 'setInterval' }
 */
export interface ResourceBinding {
    varName: string | null;   // null = not stored (fire-and-forget)
    createLine: number;
    createCall: string;       // e.g. 'setInterval', 'fs.open', 'spawn'
    scopeStart: number;       // enclosing function start
    scopeEnd: number;         // enclosing function end
}

// ── Language detection ──

export const LANG_MAP: Record<string, SideEffectLang> = {
    '.ts': 'ts', '.tsx': 'ts', '.mts': 'ts',
    '.js': 'js', '.jsx': 'js', '.mjs': 'js', '.cjs': 'js',
    '.py': 'py',
    '.go': 'go',
    '.rs': 'rs',
    '.cs': 'cs',
    '.java': 'java',
    '.rb': 'rb',
};

export const FILE_GLOBS = [
    '**/*.{ts,tsx,mts,js,jsx,mjs,cjs}',
    '**/*.py',
    '**/*.go',
    '**/*.rs',
    '**/*.cs',
    '**/*.java',
    '**/*.rb',
];

// ── Strip string contents to avoid false positives in regex matching ──

export function stripStrings(line: string): string {
    return line
        .replace(/`[^`]*`/g, '""')
        .replace(/"(?:[^"\\]|\\.)*"/g, '""')
        .replace(/'(?:[^'\\]|\\.)*'/g, '""');
}
