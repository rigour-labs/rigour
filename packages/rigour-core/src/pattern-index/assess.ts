/**
 * Before writing a function: does the codebase already have it, and is what
 * would be reused itself out of date? Shared by the MCP rigour_check_pattern
 * tool and the CLI `rigour check-pattern`.
 *
 * BLOCK means an exact or near-certain match (reuse it); WARN means a similar
 * function exists (look before writing). Deprecations come from the matched
 * function's own source, never from its name.
 */
import fs from 'fs-extra';
import path from 'path';
import { PatternMatcher } from './matcher.js';
import { StalenessDetector } from './staleness.js';
import type { PatternEntry, PatternIndex, PatternMatch, StalenessIssue } from './types.js';

export interface PatternQuery {
    name: string;
    type?: string;
    intent?: string;
    signature?: string;
    keywords?: string[];
}

export interface PatternAssessment {
    action: 'BLOCK' | 'WARN' | 'ALLOW';
    match?: PatternMatch;
    suggestion: string;
    /** Deprecated usage inside the matched function, if any. */
    deprecations: StalenessIssue[];
}

export async function assessPattern(cwd: string, index: PatternIndex, query: PatternQuery): Promise<PatternAssessment> {
    const result = await new PatternMatcher(index).match(query);
    if (result.status !== 'FOUND_SIMILAR') return { action: 'ALLOW', suggestion: '', deprecations: [] };
    const match = result.matches[0];
    const source = await readPatternSource(cwd, match.pattern);
    const staleness = source ? await new StalenessDetector(cwd).checkStaleness(source, match.pattern.file) : undefined;
    return {
        action: result.action,
        match,
        suggestion: result.suggestion,
        deprecations: staleness && staleness.status !== 'FRESH' ? staleness.issues : [],
    };
}

/** The lines a pattern spans, or undefined when its file cannot be read. */
async function readPatternSource(cwd: string, pattern: Pick<PatternEntry, 'file' | 'line' | 'endLine'>): Promise<string | undefined> {
    try {
        const lines = (await fs.readFile(path.join(cwd, pattern.file), 'utf8')).split('\n');
        return lines.slice(Math.max(0, pattern.line - 1), pattern.endLine).join('\n');
    } catch {
        return undefined;
    }
}
