/**
 * Prompt for code-aware review of scoped files.
 *
 * Unlike the facts prompt, the model sees numbered source and is asked for
 * defects it can point to at a line. Categories are a general review
 * taxonomy; they must not be tuned to any specific benchmark bug.
 */
import type { CodeContext } from './code-context.js';

/**
 * Review categories: `key` is the category the model reports, `focus` is
 * the one-line instruction for what to look for.
 */
export const REVIEW_CATEGORIES: ReadonlyArray<{ key: string; focus: string }> = [
    { key: 'correctness', focus: 'logic that returns or does the wrong thing: wrong conditions, off-by-one, wrong variable, unhandled case' },
    { key: 'scalability', focus: 'work, memory or request count that grows with data size without a bound' },
    { key: 'security', focus: 'untrusted input reaching sensitive operations, secrets exposed or sent where they should not go, missing authorization' },
    { key: 'error_handling', focus: 'failures that are swallowed, crash more than they should, or leave state inconsistent' },
    { key: 'state_and_caching', focus: 'stale, shared or cached state that can serve the wrong result' },
    { key: 'api_misuse', focus: 'a library, framework or protocol used against its documented contract' },
    { key: 'consistency', focus: 'code, messages or output that contradict what the data or other code actually does' },
];

const REVIEW_RULES = `RULES:
1. Report only defects you can point to in the source shown, with its line number.
2. A defect is behaviour that is wrong, unsafe or will fail in production. Do not report style, naming, formatting or missing comments.
3. Put identifiers from the code in backticks in the description, spelled exactly as in the source.
4. If you find nothing concrete, return {"findings": []}. An empty list is a good answer.
5. confidence: 0.9+ only when the defect is certain from the code shown; 0.5-0.7 when it depends on how callers use it.
6. Respond ONLY with JSON: {"findings":[{"category","severity","file","line","description","suggestion","confidence"}]}.`;

export function buildCodeReviewPrompt(context: CodeContext): string {
    const categories = REVIEW_CATEGORIES.map(c => `- ${c.key}: ${c.focus}`).join('\n');
    return [
        'You are a senior engineer reviewing a change before it ships. Read the source and report real defects.',
        `CATEGORIES:\n${categories}`,
        REVIEW_RULES,
        `SOURCE (line numbers on the left):\n${context.text}`,
        `Review ${context.file}. Return findings as JSON.`,
    ].join('\n\n');
}
