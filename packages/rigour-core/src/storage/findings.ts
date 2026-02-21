/**
 * Findings CRUD operations for Rigour Brain SQLite storage.
 */
import { randomUUID } from 'crypto';
import type { RigourDB } from './db.js';
import type { Failure } from '../types/index.js';

/**
 * Insert findings from a scan report into SQLite.
 */
export function insertFindings(store: RigourDB, scanId: string, failures: Failure[]): void {
    const stmt = store.db.prepare(`
        INSERT INTO findings (id, scan_id, file, line, category, severity, source, provenance, description, suggestion, confidence, verified)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertMany = store.db.transaction((items: Failure[]) => {
        for (const f of items) {
            stmt.run(
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

    insertMany(failures);
}

/**
 * Get findings for a specific scan.
 */
export function getFindingsForScan(store: RigourDB, scanId: string): any[] {
    const stmt = store.db.prepare('SELECT * FROM findings WHERE scan_id = ? ORDER BY severity ASC');
    return stmt.all(scanId);
}

/**
 * Get all deep analysis findings for a repo.
 */
export function getDeepFindings(store: RigourDB, repo: string, limit = 50): any[] {
    const stmt = store.db.prepare(`
        SELECT f.* FROM findings f
        JOIN scans s ON f.scan_id = s.id
        WHERE s.repo = ? AND f.source = 'llm'
        ORDER BY f.confidence DESC LIMIT ?
    `);
    return stmt.all(repo, limit);
}
