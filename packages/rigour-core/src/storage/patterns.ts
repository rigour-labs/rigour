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
export async function reinforcePattern(
    store: RigourDB,
    repo: string,
    pattern: string,
    description: string,
    source: 'ast' | 'llm' | 'human_feedback'
): Promise<void> {
    const now = Date.now();
    const existing = await store.get(
        'SELECT * FROM patterns WHERE repo = ? AND pattern = ?',
        repo, pattern
    );

    if (existing) {
        await store.run(
            `UPDATE patterns
             SET strength = MIN(strength + 0.15, 1.0),
                 times_seen = times_seen + 1,
                 last_seen = ?,
                 description = COALESCE(?, description)
             WHERE id = ?`,
            now, description, existing.id
        );
    } else {
        await store.run(
            `INSERT INTO patterns (id, repo, pattern, description, strength, times_seen, first_seen, last_seen, source)
             VALUES (?, ?, ?, ?, 0.3, 1, ?, ?, ?)`,
            randomUUID(), repo, pattern, description, now, now, source
        );
    }
}

/**
 * Decay patterns not seen in the last N days.
 */
export async function decayPatterns(store: RigourDB, daysThreshold = 30): Promise<number> {
    const cutoff = Date.now() - (daysThreshold * 24 * 60 * 60 * 1000);
    const result = await store.run(
        `UPDATE patterns SET strength = MAX(strength - 0.05, 0.0)
         WHERE last_seen < ?`,
        cutoff
    );

    // Prune dead patterns
    await store.run('DELETE FROM patterns WHERE strength < 0.1');

    return result.changes;
}

/**
 * Get strong patterns for a repo (strength > threshold).
 */
export async function getStrongPatterns(store: RigourDB, repo: string, threshold = 0.7): Promise<PatternRecord[]> {
    return store.all(
        'SELECT * FROM patterns WHERE repo = ? AND strength >= ? ORDER BY strength DESC',
        repo, threshold
    );
}

/**
 * Get all patterns for a repo.
 */
export async function getPatterns(store: RigourDB, repo: string): Promise<PatternRecord[]> {
    return store.all(
        'SELECT * FROM patterns WHERE repo = ? ORDER BY strength DESC',
        repo
    );
}

/**
 * Get patterns promoted to hard rules (strength > 0.9).
 * These can be used as AST-level checks without LLM inference.
 */
export async function getHardRules(store: RigourDB, repo: string): Promise<PatternRecord[]> {
    return store.all(
        'SELECT * FROM patterns WHERE repo = ? AND strength >= 0.9 ORDER BY times_seen DESC',
        repo
    );
}
