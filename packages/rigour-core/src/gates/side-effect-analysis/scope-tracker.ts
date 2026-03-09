/**
 * Scope and Context Tracking for Side-Effect Analysis
 *
 * Tracks scope boundaries, context tracking, and state during analysis.
 */

import {
    SideEffectLang,
    findEnclosingFunction,
    findBlockEndBrace,
    findBlockEndIndent,
    extractLoopBody,
    extractFunctionDefs,
    isInUseEffectWithCleanup,
    isInsideCleanupContext,
} from '../side-effect-helpers/index.js';

/**
 * Finds the enclosing function scope for a given line index.
 * Returns start and end line numbers of the scope.
 */
export function findFunctionScope(
    lines: string[],
    lineIndex: number,
    lang: SideEffectLang,
): { start: number; end: number } {
    return findEnclosingFunction(lines, lineIndex, lang);
}

/**
 * Extracts the body of a loop or block starting at the given line.
 * Handles scope-aware block detection (brace/indent tracking).
 */
export function getBlockBody(
    lines: string[],
    lineIndex: number,
    lang: SideEffectLang,
): { body: string; end: number } {
    return extractLoopBody(lines, lineIndex, lang);
}

/**
 * Checks if a timer creation is in a React useEffect with cleanup return.
 * Framework-aware pattern detection for safe side effects.
 */
export function isInFrameworkCleanup(
    lines: string[],
    lineIndex: number,
    lang: SideEffectLang,
): boolean {
    if ((lang === 'js' || lang === 'ts') && isInUseEffectWithCleanup(lines, lineIndex)) {
        return true;
    }

    if (isInsideCleanupContext(lines, lineIndex, lang)) {
        return true;
    }

    return false;
}

/**
 * Extracts all function definitions from the source code.
 * Used for recursion analysis.
 */
export function getAllFunctions(
    lines: string[],
    lang: SideEffectLang,
): Array<{ name: string; start: number; end: number; params: string }> {
    return extractFunctionDefs(lines, lang);
}
