/**
 * Pattern Matcher
 * 
 * Matches queries against the pattern index using multiple strategies:
 * 1. Exact name match
 * 2. Fuzzy name match (Levenshtein)
 * 3. Signature match
 * 4. Keyword/semantic match
 */

import type {
    PatternEntry,
    PatternIndex,
    PatternMatch,
    PatternMatchResult,
    PatternOverride
} from './types.js';
import { generateEmbedding, cosineSimilarity } from './embeddings.js';

/**
 * Configuration for pattern matching.
 */
export interface MatcherConfig {
    /** Minimum confidence threshold to include a match (0-100) */
    minConfidence: number;

    /** Maximum number of matches to return */
    maxMatches: number;

    /** Whether to use fuzzy matching */
    useFuzzy: boolean;

    /** Whether to use signature matching */
    useSignature: boolean;

    /** Whether to use keyword/semantic matching */
    useKeywords: boolean;

    /** Action when matches are found */
    defaultAction: 'BLOCK' | 'WARN' | 'ALLOW';

    /** Whether to use semantic embeddings for matching */
    useEmbeddings: boolean;
}

/** Default matcher configuration */
const DEFAULT_MATCHER_CONFIG: MatcherConfig = {
    minConfidence: 60,
    maxMatches: 5,
    useFuzzy: true,
    useSignature: true,
    useKeywords: true,
    defaultAction: 'WARN',
    useEmbeddings: true
};

/**
 * Pattern Matcher class.
 * Finds similar patterns in the index.
 */
export class PatternMatcher {
    private index: PatternIndex;
    private config: MatcherConfig;
    private overrides: PatternOverride[];
    private nameMap: Map<string, PatternEntry[]>;

    constructor(
        index: PatternIndex,
        config: Partial<MatcherConfig> = {},
        overrides: PatternOverride[] = []
    ) {
        this.index = index;
        this.config = { ...DEFAULT_MATCHER_CONFIG, ...config };
        this.overrides = overrides;

        // Build name map for O(1) lookups
        this.nameMap = new Map();
        for (const pattern of index.patterns) {
            const normalized = pattern.name.toLowerCase();
            const existing = this.nameMap.get(normalized) || [];
            existing.push(pattern);
            this.nameMap.set(normalized, existing);
        }
    }

    /**
     * Find patterns similar to a query.
     */
    async match(query: {
        name?: string;
        signature?: string;
        keywords?: string[];
        type?: string;
        intent?: string; // High-level description for semantic match
    }): Promise<PatternMatchResult> {
        const matches: PatternMatch[] = [];

        // Pre-calculate query embedding if semantic search is enabled
        let queryEmbedding: number[] | null = null;
        if (this.config.useEmbeddings && (query.intent || query.name)) {
            queryEmbedding = await generateEmbedding(`${query.name || ''} ${query.intent || ''}`);
        }

        // Check for override first
        if (query.name && this.hasOverride(query.name)) {
            return {
                query: query.name || '',
                matches: [],
                suggestion: 'Human override granted for this pattern.',
                canOverride: false,
                status: 'OVERRIDE_ALLOWED',
                action: 'ALLOW'
            };
        }

        // Strategy 1: Fast Exact name match (O(1))
        if (query.name) {
            const exactPatterns = this.nameMap.get(query.name.toLowerCase()) || [];
            for (const pattern of exactPatterns) {
                const match = this.exactNameMatch(query.name, pattern);
                if (match) {
                    matches.push(match);
                }
            }

            // If we found exact matches, we might still want to find others, 
            // but we can skip checking these specific patterns again in the main loop.
        }

        for (const pattern of this.index.patterns) {
            // Skip if we already matched this pattern via exact match
            if (query.name && pattern.name.toLowerCase() === query.name.toLowerCase()) {
                continue;
            }

            let currentBest: PatternMatch | null = null;
            let maxConfidence = -1;

            // Strategy 2: Fuzzy name match
            if (query.name && this.config.useFuzzy) {
                const match = this.fuzzyNameMatch(query.name, pattern);
                if (match && match.confidence > maxConfidence) {
                    currentBest = match;
                    maxConfidence = match.confidence;
                }
            }

            // Strategy 3: Signature match
            if (query.signature && this.config.useSignature) {
                const match = this.signatureMatch(query.signature, pattern);
                if (match && match.confidence > maxConfidence) {
                    currentBest = match;
                    maxConfidence = match.confidence;
                }
            }

            // Strategy 4: Keyword match
            if (query.keywords && query.keywords.length > 0 && this.config.useKeywords) {
                const match = this.keywordMatch(query.keywords, pattern);
                if (match && match.confidence > maxConfidence) {
                    currentBest = match;
                    maxConfidence = match.confidence;
                }
            }

            // Strategy 5: Semantic embedding match
            if (queryEmbedding && pattern.embedding && this.config.useEmbeddings) {
                const similarity = cosineSimilarity(queryEmbedding, pattern.embedding);
                const confidence = Math.round(similarity * 100);

                if (confidence > maxConfidence) {
                    currentBest = {
                        pattern,
                        matchType: 'semantic',
                        confidence,
                        reason: `Semantic match (${confidence}%): similar intent to "${pattern.name}"`
                    };
                    maxConfidence = confidence;
                }
            }

            if (currentBest && maxConfidence >= this.config.minConfidence) {
                matches.push(currentBest);
            }
        }

        // Sort by confidence and limit
        matches.sort((a, b) => b.confidence - a.confidence);
        const topMatches = matches.slice(0, this.config.maxMatches);

        // Determine status and action
        const hasExact = topMatches.some(m => m.matchType === 'exact');
        const hasHighConfidence = topMatches.some(m => m.confidence >= 90);

        let status: PatternMatchResult['status'] = 'NO_MATCH';
        let action: PatternMatchResult['action'] = 'ALLOW';
        let suggestion = '';

        if (topMatches.length > 0) {
            status = 'FOUND_SIMILAR';
            action = hasExact || hasHighConfidence ? 'BLOCK' : this.config.defaultAction;

            const best = topMatches[0];
            suggestion = this.generateSuggestion(best);
        }

        return {
            query: query.name || query.signature || query.keywords?.join(' ') || '',
            matches: topMatches,
            suggestion,
            canOverride: true,
            status,
            action
        };
    }

    /**
     * Check for exact name match.
     */
    private exactNameMatch(queryName: string, pattern: PatternEntry): PatternMatch | null {
        const normalizedQuery = queryName.toLowerCase();
        const normalizedPattern = pattern.name.toLowerCase();

        if (normalizedQuery === normalizedPattern) {
            return {
                pattern,
                matchType: 'exact',
                confidence: 100,
                reason: `Exact match: "${pattern.name}" already exists in ${pattern.file}`
            };
        }

        return null;
    }

    /**
     * Check for fuzzy name match using Levenshtein distance.
     */
    private fuzzyNameMatch(queryName: string, pattern: PatternEntry): PatternMatch | null {
        const distance = this.levenshteinDistance(
            queryName.toLowerCase(),
            pattern.name.toLowerCase()
        );

        const maxLength = Math.max(queryName.length, pattern.name.length);
        const similarity = 1 - (distance / maxLength);
        const confidence = Math.round(similarity * 100);

        // Also check word overlap
        const queryWords = this.extractWords(queryName);
        const patternWords = this.extractWords(pattern.name);
        const wordOverlap = this.calculateWordOverlap(queryWords, patternWords);

        // Combine word overlap with character similarity
        const combinedConfidence = Math.round((confidence + wordOverlap * 100) / 2);

        if (combinedConfidence >= 60) {
            return {
                pattern,
                matchType: 'fuzzy',
                confidence: combinedConfidence,
                reason: `Similar name: "${pattern.name}" in ${pattern.file} (${combinedConfidence}% similar)`
            };
        }

        return null;
    }

    /**
     * Check for signature match.
     */
    private signatureMatch(querySignature: string, pattern: PatternEntry): PatternMatch | null {
        if (!pattern.signature) return null;

        // Normalize signatures for comparison
        const normalizedQuery = this.normalizeSignature(querySignature);
        const normalizedPattern = this.normalizeSignature(pattern.signature);

        if (normalizedQuery === normalizedPattern) {
            return {
                pattern,
                matchType: 'signature',
                confidence: 85,
                reason: `Matching signature: ${pattern.name}${pattern.signature} in ${pattern.file}`
            };
        }

        // Check parameter count and types
        const queryParams = this.extractParameters(querySignature);
        const patternParams = this.extractParameters(pattern.signature);

        if (queryParams.length === patternParams.length && queryParams.length > 0) {
            const typeMatch = this.compareParameterTypes(queryParams, patternParams);
            if (typeMatch >= 0.7) {
                const confidence = Math.round(60 + typeMatch * 20);
                return {
                    pattern,
                    matchType: 'signature',
                    confidence,
                    reason: `Similar signature (${confidence}% match): ${pattern.name} in ${pattern.file}`
                };
            }
        }

        return null;
    }

    /**
     * Check for keyword/semantic match.
     */
    private keywordMatch(queryKeywords: string[], pattern: PatternEntry): PatternMatch | null {
        if (!pattern.keywords || pattern.keywords.length === 0) return null;

        const normalizedQuery = queryKeywords.map(k => k.toLowerCase());
        const normalizedPattern = pattern.keywords.map(k => k.toLowerCase());

        const matches = normalizedQuery.filter(k => normalizedPattern.includes(k));
        const overlap = matches.length / Math.max(normalizedQuery.length, normalizedPattern.length);

        if (overlap >= 0.5) {
            const confidence = Math.round(50 + overlap * 40);
            return {
                pattern,
                matchType: 'semantic',
                confidence,
                reason: `Semantic match (keywords: ${matches.join(', ')}): ${pattern.name} in ${pattern.file}`
            };
        }

        return null;
    }

    /**
     * Check if an override exists for a pattern.
     */
    private hasOverride(name: string): boolean {
        const now = new Date();

        return this.overrides.some(override => {
            // Check expiration
            if (override.expiresAt && new Date(override.expiresAt) < now) {
                return false;
            }

            // Check pattern match (supports globs)
            if (override.pattern.includes('*')) {
                const regex = new RegExp(
                    '^' + override.pattern.replace(/\*/g, '.*') + '$'
                );
                return regex.test(name);
            }

            return override.pattern === name;
        });
    }

    /**
     * Generate a suggestion message.
     */
    private generateSuggestion(match: PatternMatch): string {
        const { pattern } = match;

        if (pattern.exported) {
            return `Import "${pattern.name}" from "${pattern.file}" instead of creating a new one.`;
        }

        return `A similar pattern "${pattern.name}" exists in "${pattern.file}". Consider reusing it or extracting it to a shared location.`;
    }

    /**
     * Calculate Levenshtein distance between two strings.
     */
    private levenshteinDistance(a: string, b: string): number {
        const matrix: number[][] = [];

        for (let i = 0; i <= b.length; i++) {
            matrix[i] = [i];
        }

        for (let j = 0; j <= a.length; j++) {
            matrix[0][j] = j;
        }

        for (let i = 1; i <= b.length; i++) {
            for (let j = 1; j <= a.length; j++) {
                if (b.charAt(i - 1) === a.charAt(j - 1)) {
                    matrix[i][j] = matrix[i - 1][j - 1];
                } else {
                    matrix[i][j] = Math.min(
                        matrix[i - 1][j - 1] + 1, // substitution
                        matrix[i][j - 1] + 1,     // insertion
                        matrix[i - 1][j] + 1      // deletion
                    );
                }
            }
        }

        return matrix[b.length][a.length];
    }

    /**
     * Extract words from a camelCase/PascalCase name.
     */
    private extractWords(name: string): string[] {
        return name
            .replace(/([a-z])([A-Z])/g, '$1 $2')
            .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
            .toLowerCase()
            .split(/[\s_-]+/)
            .filter(w => w.length > 1);
    }

    /**
     * Calculate word overlap ratio.
     */
    private calculateWordOverlap(words1: string[], words2: string[]): number {
        const set1 = new Set(words1);
        const set2 = new Set(words2);

        let matches = 0;
        for (const word of set1) {
            if (set2.has(word)) {
                matches++;
            }
        }

        return matches / Math.max(set1.size, set2.size);
    }

    /**
     * Normalize a signature for comparison.
     */
    private normalizeSignature(sig: string): string {
        return sig
            .replace(/\s+/g, '')           // Remove whitespace
            .replace(/:\s*\w+/g, '')        // Remove type annotations
            .replace(/\?/g, '')             // Remove optional markers
            .toLowerCase();
    }

    /**
     * Extract parameters from a signature.
     */
    private extractParameters(sig: string): string[] {
        const match = sig.match(/\(([^)]*)\)/);
        if (!match) return [];

        return match[1]
            .split(',')
            .map(p => p.trim())
            .filter(p => p.length > 0);
    }

    /**
     * Compare parameter types between two signatures.
     */
    private compareParameterTypes(params1: string[], params2: string[]): number {
        let matches = 0;

        for (let i = 0; i < params1.length; i++) {
            const type1 = this.extractType(params1[i]);
            const type2 = this.extractType(params2[i]);

            if (type1 === type2) {
                matches++;
            } else if (type1 && type2 && (type1.includes(type2) || type2.includes(type1))) {
                matches += 0.5;
            }
        }

        return matches / params1.length;
    }

    /**
     * Extract type from a parameter declaration.
     */
    private extractType(param: string): string | null {
        const match = param.match(/:\s*(\w+)/);
        return match ? match[1].toLowerCase() : null;
    }
}

/**
 * Quick helper to check for pattern duplicates.
 */
export async function checkPatternDuplicate(
    index: PatternIndex,
    name: string,
    options: Partial<MatcherConfig> = {}
): Promise<PatternMatchResult> {
    const matcher = new PatternMatcher(index, options);
    return matcher.match({ name });
}
