/**
 * Logic Drift Gate — Drift-Specific Analysis Helpers
 *
 * Language-specific extraction (stripComments, countBranches, etc.) now
 * delegates to the language adapter layer. This module retains only the
 * drift-detection logic that is specific to the gate.
 */

// ─── Logic Drift-Specific Functions ───────────────────────────────

/**
 * Extract ordered sequence of function calls
 */
export function extractCallSequence(body: string): string[] {
    const calls: string[] = [];
    const matches = body.matchAll(/\b(\w+)\s*\(/g);
    const keywords = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'async', 'await', 'return', 'new', 'typeof', 'instanceof']);
    for (const m of matches) {
        if (!keywords.has(m[1])) {
            calls.push(m[1]);
        }
    }
    return calls;
}

/**
 * Classify whether an operator change is "dangerous" (likely unintentional)
 */
export function isDangerousMutation(from: string, to: string): boolean {
    const dangerous = new Set([
        '>=:>', '>:>=',
        '<=:<', '<:<=',
        '===:==', '==:===',
        '!==:!=', '!=:!==',
    ]);
    return dangerous.has(`${from}:${to}`);
}
