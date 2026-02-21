/**
 * Pattern learning and reinforcement for Rigour Brain.
 * Patterns grow in strength when seen repeatedly, decay when absent.
 */
import { randomUUID } from 'crypto';
import type { RigourDB } from './db.js';

export interface PatternRecord {
    id: string;
    repo: string | null;
    pattern: string;
    description: string | null;
    strength: number;
    times_seen: number;
    first_seen: number;
    last_seen: number;
    source: string;
}

/**
 * Record or reinforce a pattern.
 * If the pattern already exists for this repo, increase strength.
 * Otherwise, create a new pattern.
 */
export function reinforcePattern(
    store: RigourDB,
    repo: string,
    pattern: string,
    description: string,
    source: 'ast' | 'llm' | 'human_feedback'
): void {
    const now = Date.now();
    const existing = store.db.prepare(
        'SELECT * FROM patterns WHERE repo = ? AND pattern = ?'
    ).get(repo, pattern);

    if (existing) {
        store.db.prepare(`
            UPDATE patterns
            SET strength = MIN(strength + 0.15, 1.0),
                times_seen = times_seen + 1,
                last_seen = ?,
                description = COALESCE(?, description)
            WHERE id = ?
        `).run(now, description, existing.id);
    } else {
        store.db.prepare(`
            INSERT INTO patterns (id, repo, pattern, description, strength, times_seen, first_seen, last_seen, source)
            VALUES (?, ?, ?, ?, 0.3, 1, ?, ?, ?)
        `).run(randomUUID(), repo, pattern, description, now, now, source);
    }
}

/**
 * Decay patterns not seen in the last N days.
 */
export function decayPatterns(store: RigourDB, daysThreshold = 30): number {
    const cutoff = Date.now() - (daysThreshold * 24 * 60 * 60 * 1000);
    const result = store.db.prepare(`
        UPDATE patterns SET strength = MAX(strength - 0.05, 0.0)
        WHERE last_seen < ?
    `).run(cutoff);

    // Prune dead patterns
    store.db.prepare('DELETE FROM patterns WHERE strength < 0.1').run();

    return result.changes;
}

/**
 * Get strong patterns for a repo (strength > threshold).
 */
export function getStrongPatterns(store: RigourDB, repo: string, threshold = 0.7): PatternRecord[] {
    return store.db.prepare(
        'SELECT * FROM patterns WHERE repo = ? AND strength >= ? ORDER BY strength DESC'
    ).all(repo, threshold);
}

/**
 * Get all patterns for a repo.
 */
export function getPatterns(store: RigourDB, repo: string): PatternRecord[] {
    return store.db.prepare(
        'SELECT * FROM patterns WHERE repo = ? ORDER BY strength DESC'
    ).all(repo);
}

/**
 * Get patterns promoted to hard rules (strength > 0.9).
 * These can be used as AST-level checks without LLM inference.
 */
export function getHardRules(store: RigourDB, repo: string): PatternRecord[] {
    return store.db.prepare(
        'SELECT * FROM patterns WHERE repo = ? AND strength >= 0.9 ORDER BY times_seen DESC'
    ).all(repo);
}
