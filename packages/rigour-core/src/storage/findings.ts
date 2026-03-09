/**
 * Findings CRUD operations for Rigour Brain SQLite storage.
 */
import { randomUUID } from 'crypto';
import type { RigourDB } from './db.js';
import type { Failure } from '../types/index.js';

/**
 * Insert findings from a scan report into SQLite.
 * Uses a transaction for atomicity on bulk inserts.
 */
export async function insertFindings(store: RigourDB, scanId: string, failures: Failure[]): Promise<void> {
    await store.transaction(async (tx) => {
        for (const f of failures) {
            await tx.run(
                `INSERT INTO findings (id, scan_id, file, line, category, severity, source, provenance, description, suggestion, confidence, verified)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                randomUUID(),
                scanId,
                f.files?.[0] || 'unknown',
                f.line ?? null,
                f.category || f.id,
                f.severity || 'medium',
                f.source || 'ast',
                f.provenance || 'traditional',
                f.details,
                f.hint ?? null,
                f.confidence ?? null,
                f.verified ? 1 : 0
            );
        }
    });
}

/**
 * Get findings for a specific scan.
 */
export async function getFindingsForScan(store: RigourDB, scanId: string): Promise<any[]> {
    return store.all('SELECT * FROM findings WHERE scan_id = ? ORDER BY severity ASC', scanId);
}

/**
 * Get deep analysis and high-confidence AST findings for a repo.
 * Used by local memory to match known patterns against new scans.
 */
export async function getDeepFindings(store: RigourDB, repo: string, limit = 50): Promise<any[]> {
    return store.all(
        `SELECT f.* FROM findings f
         JOIN scans s ON f.scan_id = s.id
         WHERE s.repo = ? AND (f.source = 'llm' OR f.source = 'hybrid' OR f.confidence >= 0.7)
         ORDER BY f.confidence DESC LIMIT ?`,
        repo, limit
    );
}
