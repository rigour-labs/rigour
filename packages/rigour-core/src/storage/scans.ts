/**
 * Scan CRUD operations for Rigour Brain SQLite storage.
 */
import { randomUUID } from 'crypto';
import type { RigourDB } from './db.js';
import type { Report } from '../types/index.js';

export interface ScanRecord {
    id: string;
    repo: string;
    commit_hash?: string;
    timestamp: number;
    ai_health_score?: number;
    code_quality_score?: number;
    overall_score?: number;
    files_scanned?: number;
    duration_ms?: number;
    deep_tier?: string;
    deep_model?: string;
}

/**
 * Insert a scan record from a Rigour report.
 */
export function insertScan(
    store: RigourDB,
    repo: string,
    report: Report,
    meta?: { commitHash?: string; filesScanned?: number; deepTier?: string; deepModel?: string }
): string {
    const id = randomUUID();
    const stmt = store.db.prepare(`
        INSERT INTO scans (id, repo, commit_hash, timestamp, ai_health_score, code_quality_score, overall_score, files_scanned, duration_ms, deep_tier, deep_model)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
        id,
        repo,
        meta?.commitHash || null,
        Date.now(),
        report.stats.ai_health_score ?? null,
        report.stats.code_quality_score ?? null,
        report.stats.score ?? null,
        meta?.filesScanned ?? null,
        report.stats.duration_ms,
        meta?.deepTier ?? null,
        meta?.deepModel ?? null
    );

    return id;
}

/**
 * Get recent scans for a repo (newest first).
 */
export function getRecentScans(store: RigourDB, repo: string, limit = 10): ScanRecord[] {
    const stmt = store.db.prepare(`
        SELECT * FROM scans WHERE repo = ? ORDER BY timestamp DESC LIMIT ?
    `);
    return stmt.all(repo, limit);
}

/**
 * Get score trend for a repo.
 */
export function getScoreTrendFromDB(store: RigourDB, repo: string, limit = 10): {
    scores: number[];
    direction: 'improving' | 'degrading' | 'stable';
} {
    const scans = getRecentScans(store, repo, limit);
    const scores = scans
        .filter(s => s.overall_score != null)
        .map(s => s.overall_score!)
        .reverse(); // oldest first

    if (scores.length < 2) return { scores, direction: 'stable' };

    const recent = scores.slice(-3);
    const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
    const older = scores.slice(0, -3);
    const olderAvg = older.length > 0 ? older.reduce((a, b) => a + b, 0) / older.length : avg;

    const direction = avg > olderAvg + 2 ? 'improving' : avg < olderAvg - 2 ? 'degrading' : 'stable';
    return { scores, direction };
}

/**
 * Get most common issue categories for a repo.
 */
export function getTopIssues(store: RigourDB, repo: string, limit = 10): { category: string; count: number }[] {
    const stmt = store.db.prepare(`
        SELECT f.category, COUNT(*) as count FROM findings f
        JOIN scans s ON f.scan_id = s.id
        WHERE s.repo = ?
        GROUP BY f.category ORDER BY count DESC LIMIT ?
    `);
    return stmt.all(repo, limit);
}
