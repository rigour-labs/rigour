/**
 * Language Adapter Types
 *
 * Unified interface for language-specific code analysis.
 * Gates use these adapters instead of inline `if ext === '.py'` chains.
 */

export interface LanguageAdapter {
    /** Language identifier (e.g., 'js', 'python', 'go') */
    readonly id: string;
    /** Human-readable name */
    readonly name: string;
    /** File extensions this adapter handles (e.g., ['.py', '.pyw']) */
    readonly extensions: string[];

    /** Extract function declarations from source */
    extractFunctions(source: string, filePath?: string): FunctionFact[];
    /** Extract import statements */
    extractImports(source: string): ImportFact[];
    /** Extract error handling patterns */
    extractErrorHandlers(source: string): ErrorHandlerFact[];
    /** Extract naming patterns (variables, functions, classes) */
    extractNamingPatterns(source: string): NamingPattern[];
    /** Strip comments from source (for analysis accuracy) */
    stripComments(source: string): string;
    /** Detect comparison operators in a code block */
    extractComparisonOps(source: string): string[];
    /** Count branch points (if/else/switch/match) */
    countBranches(source: string): number;
    /** Count return points */
    countReturns(source: string): number;
}

export interface FunctionFact {
    name: string;
    startLine: number;
    endLine: number;
    body: string;
    isAsync: boolean;
    isExported: boolean;
}

export interface ImportFact {
    module: string;
    names: string[];       // empty = default/wildcard import
    line: number;
    isDynamic: boolean;
}

export interface ErrorHandlerFact {
    type: string;          // 'try-catch' | 'if-err' | 'rescue' | 'except'
    strategy: string;      // 'rethrow' | 'log' | 'swallow' | 'wrap' | 'return-error'
    startLine: number;
    body: string;
}

export interface NamingPattern {
    name: string;
    kind: 'function' | 'class' | 'variable' | 'constant' | 'method';
    convention: NamingConvention;
}

export type NamingConvention =
    | 'camelCase'
    | 'PascalCase'
    | 'snake_case'
    | 'SCREAMING_SNAKE'
    | 'kebab-case'
    | 'other';

/**
 * Classify a name into its casing convention.
 */
export function classifyCasing(name: string): NamingConvention {
    if (/^[A-Z][A-Z0-9_]*$/.test(name)) return 'SCREAMING_SNAKE';
    if (/^[A-Z][a-zA-Z0-9]*$/.test(name)) return 'PascalCase';
    if (/^[a-z][a-zA-Z0-9]*$/.test(name)) return 'camelCase';
    if (/^[a-z][a-z0-9_]*$/.test(name)) return 'snake_case';
    if (/^[a-z][a-z0-9-]*$/.test(name)) return 'kebab-case';
    return 'other';
}
