/**
 * Local Project Memory — the hybrid intelligence layer.
 *
 * Before deep scan: checks local SQLite for known patterns in this project.
 * After any scan: stores verified findings and reinforces patterns.
 * Result: Rigour gets smarter every time you use it, code never leaves the machine.
 */
import path from 'path';
import type { Failure } from '../types/index.js';
import type { DeepFinding } from '../inference/types.js';
import { openDatabase } from './db.js';
import { insertScan, getRecentScans } from './scans.js';
import { insertFindings, getDeepFindings } from './findings.js';
import { reinforcePattern, getStrongPatterns, getHardRules, decayPatterns } from './patterns.js';
import { Logger } from '../utils/logger.js';

/** Minimum pattern strength to produce instant findings (skip LLM). */
const INSTANT_MATCH_THRESHOLD = 0.7;

/** Max local findings to inject per scan (avoid flooding). */
const MAX_LOCAL_FINDINGS = 15;

/** Min confidence to reuse a past finding from local memory. */
const MIN_REUSE_CONFIDENCE = 0.7;

/**
 * Build a map of relative file path → known issues from past findings.
 */
function buildFileIssueMap(recentFindings: any[]): Map<string, any[]> {
    const map = new Map<string, any[]>();
    for (const f of recentFindings) {
        const existing = map.get(f.file) || [];
        existing.push(f);
        map.set(f.file, existing);
    }
    return map;
}

/**
 * Pre-scan: check local SQLite for known patterns → produce instant findings.
 * Returns findings that match known project patterns, WITHOUT model inference.
 *
 * @param cwd     - Absolute project root path
 * @param fileList - Relative file paths (from FileFacts.path or globby)
 */
export function checkLocalPatterns(
    cwd: string,
    fileList: string[],
): DeepFinding[] {
    const db = openDatabase();
    if (!db) return [];

    const repoName = path.basename(cwd);
    const findings: DeepFinding[] = [];

    try {
        const patterns = getStrongPatterns(db, repoName, INSTANT_MATCH_THRESHOLD);
        if (patterns.length === 0) return [];

        // Include both AST and LLM findings from history
        const recentFindings = getDeepFindings(db, repoName, 200);
        if (recentFindings.length === 0) return [];

        const fileIssueMap = buildFileIssueMap(recentFindings);

        // fileList contains relative paths — match directly against DB (also relative)
        for (const relPath of fileList) {
            const known = fileIssueMap.get(relPath);
            if (!known) continue;

            for (const issue of known) {
                if ((issue.confidence ?? 0) < MIN_REUSE_CONFIDENCE) continue;

                const matchingPattern = patterns.find(
                    (p: any) => p.pattern === issue.category && p.strength >= INSTANT_MATCH_THRESHOLD
                );
                if (!matchingPattern) continue;

                findings.push({
                    category: issue.category,
                    severity: issue.severity || 'medium',
                    file: relPath,
                    line: issue.line ?? undefined,
                    description: `[Local Memory] ${issue.description}`,
                    suggestion: issue.suggestion || 'Review this known issue.',
                    confidence: Math.min(matchingPattern.strength, issue.confidence ?? 0.5),
                });

                if (findings.length >= MAX_LOCAL_FINDINGS) break;
            }
            if (findings.length >= MAX_LOCAL_FINDINGS) break;
        }
    } catch (error) {
        Logger.warn(`Local memory check failed: ${error}`);
    } finally {
        db?.db.close();
    }

    return findings;
}

/**
 * Post-scan: persist findings and reinforce patterns.
 * Wrapped in a single transaction for atomicity.
 * Called after every scan (check, scan, scan --deep).
 */
export function persistAndReinforce(
    cwd: string,
    report: { status: string; failures: Failure[]; stats: any },
    meta?: { deepTier?: string; deepModel?: string },
): void {
    const db = openDatabase();
    if (!db) return;

    const repoName = path.basename(cwd);

    try {
        // Wrap all writes in a single transaction for atomicity
        const persist = db.db.transaction(() => {
            const scanId = insertScan(db, repoName, report as any, meta);

            if (report.failures.length > 0) {
                insertFindings(db, scanId, report.failures);
            }

            for (const f of report.failures) {
                const category = f.category || f.id;
                const source: 'ast' | 'llm' = f.source === 'llm' ? 'llm' : 'ast';
                reinforcePattern(
                    db, repoName, category,
                    `${f.title}: ${f.details?.substring(0, 120)}`,
                    source,
                );
            }

            decayPatterns(db, 30);
        });

        persist();

        Logger.info(
            `Local memory: stored ${report.failures.length} findings, ` +
            `reinforced ${report.failures.length} patterns for ${repoName}`
        );
    } catch (error) {
        Logger.warn(`Local memory persist failed: ${error}`);
    } finally {
        db?.db.close();
    }
}

/**
 * Get project learning stats (for display in scan output).
 */
export function getProjectStats(cwd: string): ProjectStats | null {
    const db = openDatabase();
    if (!db) return null;

    const repoName = path.basename(cwd);

    try {
        const scans = getRecentScans(db, repoName, 100);
        const patterns = getStrongPatterns(db, repoName, 0.3);
        const hardRules = getHardRules(db, repoName);

        return {
            totalScans: scans.length,
            learnedPatterns: patterns.length,
            hardRules: hardRules.length,
            topPatterns: patterns.slice(0, 5).map(p => ({
                name: p.pattern,
                strength: p.strength,
                timesSeen: p.times_seen,
            })),
        };
    } catch {
        return null;
    } finally {
        db?.db.close();
    }
}

export interface ProjectStats {
    totalScans: number;
    learnedPatterns: number;
    hardRules: number;
    topPatterns: Array<{ name: string; strength: number; timesSeen: number }>;
}
