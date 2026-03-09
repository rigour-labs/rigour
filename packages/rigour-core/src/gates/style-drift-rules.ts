/**
 * Style Drift Detection Gate — Naming Convention Rules and Regexes
 *
 * Contains per-language naming convention rules and naming pattern regexes.
 */

/**
 * Casing classification rules
 */
export function classifyCasing(name: string): 'camelCase' | 'snake_case' | 'PascalCase' | 'SCREAMING_SNAKE' | null {
    if (name.startsWith('_') || name.length <= 1) return null;

    if (/^[A-Z][A-Z0-9_]+$/.test(name)) {
        return 'SCREAMING_SNAKE';
    } else if (/^[A-Z]/.test(name)) {
        return 'PascalCase';
    } else if (name.includes('_')) {
        return 'snake_case';
    } else {
        return 'camelCase';
    }
}

/**
 * Function name pattern for JavaScript
 */
export const JS_FUNCTION_PATTERN = /(?:function|async\s+function)\s+(\w+)/;

/**
 * Method definition pattern for all languages
 */
export const METHOD_PATTERN = /^\s+(?:async\s+)?(\w+)\s*\([^)]*\)\s*[{:]/;

/**
 * Arrow function assignment pattern
 */
export const ARROW_FUNCTION_PATTERN = /(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|(\w+))\s*=>/;

/**
 * Variable declaration pattern (non-function)
 */
export const VAR_DECLARATION_PATTERN = /(?:const|let|var)\s+(\w+)\s*=/;

/**
 * Python function pattern
 */
export const PYTHON_FUNCTION_PATTERN = /def\s+(\w+)/;

/**
 * Python variable pattern
 */
export const PYTHON_VAR_PATTERN = /^(\w+)\s*=/;

/**
 * Go function pattern
 */
export const GO_FUNCTION_PATTERN = /^func\s+(?:\([^)]+\)\s+)?(\w+)/;

/**
 * Go variable pattern
 */
export const GO_VAR_PATTERN = /^\s*(\w+)\s*:?=/;

/**
 * Rust function pattern
 */
export const RUST_FUNCTION_PATTERN = /fn\s+(\w+)/;

/**
 * Rust variable pattern
 */
export const RUST_VAR_PATTERN = /let\s+(?:mut\s+)?(\w+)/;

/**
 * Ruby method pattern
 */
export const RUBY_METHOD_PATTERN = /def\s+(?:self\.)?(\w+)/;

/**
 * Ruby variable pattern
 */
export const RUBY_VAR_PATTERN = /^\s*(\w+)\s*=/;

/**
 * Java/Kotlin/C# method pattern
 */
export const JAVA_METHOD_PATTERN = /(?:public|private|protected|internal|static|override|virtual|abstract)\s+(?:\w+\s+)*(\w+)\s*\(/;

/**
 * Java/Kotlin/C# variable pattern
 */
export const JAVA_VAR_PATTERN = /(?:var|val|final)?\s*\w+\s+(\w+)\s*[=;]/;

/**
 * Error handling patterns
 */
export const TRY_CATCH_PATTERN = /\btry\s*\{|\btry\s*:/;
export const CATCH_PATTERN = /\.catch\s*\(|\bexcept\b|\brescue\b/;
export const RESULT_TYPE_PATTERN = /Result<|Result\[|Err\(|Ok\(|Either<|\bif\s+err\s*!=\s*nil\b/;

/**
 * Import style patterns
 */
export const NAMED_IMPORT_PATTERN = /^import\s+\{/;
export const WILDCARD_IMPORT_PATTERN = /^import\s+\*\s+as/;
export const SIDE_EFFECT_IMPORT_PATTERN = /^import\s+['"]/ ;
export const DEFAULT_IMPORT_PATTERN = /^import\s+\w/;

/**
 * Quote style detection
 */
export function countQuotes(line: string): { single: number; double: number; backtick: number } {
    return {
        single: (line.match(/'/g) || []).length,
        double: (line.match(/"/g) || []).length,
        backtick: (line.match(/`/g) || []).length,
    };
}
