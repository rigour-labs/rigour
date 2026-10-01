/**
 * Router: which changed files a paid model reviews.
 *
 * Files are chosen through their riskiest changed function (risk.ts). A file
 * the ranking cannot see into (another language, or a change outside any
 * function) is always reviewed: the router only cuts what it understands.
 */
import type { RemovedBlock } from '../utils/diff.js';
import { rankChangedFunctions } from './risk.js';

export interface RouterPolicy {
    enabled?: boolean;
    min_score?: number;
    max_functions?: number;
}

export interface RouterStats {
    functions: number;
    routed: number;
    files_skipped: number;
}

export const DEFAULT_MIN_SCORE = 1;
export const DEFAULT_MAX_FUNCTIONS = 12;

export function routeFiles(
    cwd: string, files: string[], focusLines: Record<string, number[]>, removed: Record<string, RemovedBlock[]> = {}, policy: RouterPolicy = {},
): { files: Set<string>; stats: RouterStats } {
    const inScope = Object.fromEntries(files.filter(f => focusLines[f]?.length).map(f => [f, focusLines[f]]));
    const ranked = rankChangedFunctions(cwd, inScope, removed);
    const minScore = policy.min_score ?? DEFAULT_MIN_SCORE;
    const routed = ranked.filter(f => f.score >= minScore).slice(0, policy.max_functions ?? DEFAULT_MAX_FUNCTIONS);
    const ranks = new Set(ranked.map(f => f.file));
    const chosen = new Set([...routed.map(f => f.file), ...files.filter(f => !ranks.has(f))]);
    return { files: chosen, stats: { functions: ranked.length, routed: routed.length, files_skipped: files.length - chosen.size } };
}
