/**
 * Pattern Index - Types
 * 
 * Core type definitions for the Pattern Index system.
 * Rigour's Pattern Index prevents AI from reinventing existing code.
 */

/**
 * All supported pattern types that can be indexed.
 * Organized by category for clarity.
 */
export type PatternType =
    // === CODE PATTERNS ===
    | 'function'           // Standalone functions, utilities
    | 'class'              // Classes
    | 'method'             // Class methods (indexed separately for reuse)
    | 'component'          // React/Vue/Svelte components
    | 'hook'               // React hooks (useX)
    | 'decorator'          // Python/TS decorators
    | 'middleware'         // Express/FastAPI middleware

    // === DATA PATTERNS ===
    | 'type'               // TypeScript types
    | 'interface'          // TypeScript interfaces
    | 'schema'             // Zod, Yup, JSON Schema validators
    | 'model'              // Database models (Prisma, SQLAlchemy, etc.)
    | 'enum'               // Enumerations

    // === CONFIGURATION ===
    | 'constant'           // Constants, magic values
    | 'config'             // Configuration objects
    | 'env'                // Environment variable patterns

    // === API PATTERNS ===
    | 'route'              // API routes/endpoints
    | 'handler'            // Route handlers
    | 'resolver'           // GraphQL resolvers
    | 'rpc'                // tRPC procedures

    // === STATE PATTERNS ===
    | 'store'              // State stores (Zustand, Redux)
    | 'reducer'            // Redux reducers
    | 'action'             // Actions/mutations
    | 'selector'           // State selectors

    // === ERROR HANDLING ===
    | 'error'              // Custom error classes
    | 'exception'          // Exception types

    // === TESTING ===
    | 'mock'               // Mock objects/functions
    | 'fixture'            // Test fixtures
    | 'factory'            // Test factories

    // === INFRASTRUCTURE ===
    | 'command'            // CLI commands
    | 'task'               // Background tasks/jobs
    | 'event'              // Event types/handlers
    | 'protocol';          // Python protocols, abstract classes

/**
 * A single indexed pattern entry.
 */
export interface PatternEntry {
    /** Unique identifier (hash of file + name) */
    id: string;

    /** The type of pattern */
    type: PatternType;

    /** Name of the pattern (e.g., "formatDate") */
    name: string;

    /** Relative path to the file */
    file: string;

    /** Line number where the pattern is defined */
    line: number;

    /** End line number */
    endLine: number;

    /** Function/method signature if applicable */
    signature: string;

    /** Description from JSDoc/docstring */
    description: string;

    /** Extracted semantic keywords for matching */
    keywords: string[];

    /** Content hash for change detection */
    hash: string;

    /** Is this pattern exported? */
    exported: boolean;

    /** How many files import this pattern */
    usageCount: number;            // How many files import this?

    /** User-defined category/grouping */
    category?: string;             // User-defined grouping
    embedding?: number[];          // Vector embedding for semantic search

    /** Last indexed timestamp */
    indexedAt: string;
}

/**
 * The complete pattern index structure.
 */
export interface PatternIndex {
    /** Index format version */
    version: string;

    /** Version of the text its embeddings were built from (embeddings.ts EMBEDDING_TEXT_VERSION). */
    embeddingTextVersion?: number;

    /** When the index was last updated */
    lastUpdated: string;

    /** Root directory that was indexed */
    rootDir: string;

    /** All indexed patterns */
    patterns: PatternEntry[];

    /** Index statistics */
    stats: PatternIndexStats;

    /** Files that were indexed */
    files: IndexedFile[];
}

/**
 * Statistics about the pattern index.
 */
export interface PatternIndexStats {
    totalPatterns: number;
    totalFiles: number;
    byType: Record<PatternType, number>;
    indexDurationMs: number;
}

/**
 * Information about an indexed file.
 */
export interface IndexedFile {
    path: string;
    hash: string;
    patternCount: number;
    indexedAt: string;
}

/**
 * Configuration for the pattern indexer.
 */
export interface PatternIndexConfig {
    /** Directories to index (defaults to src/) */
    include: string[];

    /** Directories to exclude */
    exclude: string[];

    /** File extensions to index */
    extensions: string[];

    /** Whether to index test files */
    indexTests: boolean;

    /** Whether to index node_modules */
    indexNodeModules: boolean;

    /** Minimum pattern name length to index */
    minNameLength: number;

    /** Custom categories for patterns */
    categories: Record<string, string[]>;

    /** Whether to generate semantic embeddings for patterns */
    useEmbeddings?: boolean;
}

/**
 * Result from matching against the pattern index.
 */
export interface PatternMatchResult {
    /** The query that was matched */
    query: string;

    /** All matches found */
    matches: PatternMatch[];

    /** Suggestion for what to do */
    suggestion: string;

    /** Whether human override is available */
    canOverride: boolean;

    /** Overall status */
    status: 'FOUND_SIMILAR' | 'NO_MATCH' | 'OVERRIDE_ALLOWED';

    /** Recommended action */
    action: 'BLOCK' | 'WARN' | 'ALLOW';
}

/**
 * A single pattern match.
 */
export interface PatternMatch {
    /** The matched pattern */
    pattern: PatternEntry;

    /** How the match was determined */
    matchType: 'exact' | 'fuzzy' | 'signature' | 'semantic';

    /** Confidence score 0-100 */
    confidence: number;

    /** Human-readable reason for the match */
    reason: string;
}

/**
 * Human override entry.
 */
export interface PatternOverride {
    /** Pattern name or glob */
    pattern: string;

    /** Why the override was granted */
    reason: string;

    /** When the override expires */
    expiresAt?: string;

    /** Who approved the override */
    approvedBy?: string;

    /** When the override was created */
    createdAt: string;
}

/**
 * Staleness detection result.
 */
export interface StalenessResult {
    /** Overall status */
    status: 'FRESH' | 'STALE' | 'DEPRECATED';

    /** All staleness issues found */
    issues: StalenessIssue[];

    /** Project context (versions) */
    projectContext: Record<string, string>;
}

/**
 * A single staleness issue.
 */
export interface StalenessIssue {
    /** Line number */
    line: number;

    /** The stale pattern */
    pattern: string;

    /** Severity */
    severity: 'error' | 'warning' | 'info';

    /** Why it's stale */
    reason: string;

    /** What to use instead */
    replacement: string;

    /** Link to documentation */
    docs?: string;
}

/**
 * Security/CVE entry for a package.
 */
export interface SecurityEntry {
    /** CVE Identifier (e.g., CVE-2021-1234) */
    cveId: string;

    /** Package name */
    packageName: string;

    /** Vulnerable version range (semver) */
    vulnerableRange: string;

    /** Severity level */
    severity: 'critical' | 'high' | 'moderate' | 'low';

    /** Brief description of the vulnerability */
    title: string;

    /** Link to advisory */
    url: string;

    /** The version of the package in the current project */
    currentVersion?: string;
}

/**
 * Result from security check.
 */
export interface SecurityResult {
    /** Overall security status */
    status: 'SECURE' | 'VULNERABLE';

    /** All CVEs/vulnerabilities found */
    vulnerabilities: SecurityEntry[];
}

/**
 * Deprecation entry in the deprecation database.
 */
export interface DeprecationEntry {
    /** Pattern to match (can be regex) */
    pattern: string;

    /** Library this belongs to */
    library?: string;

    /** Version when deprecated */
    deprecatedIn: string;

    /** Suggested replacement */
    replacement: string;

    /** Severity level */
    severity: 'error' | 'warning' | 'info';

    /** Additional context */
    reason?: string;

    /** Documentation link */
    docs?: string;
}
