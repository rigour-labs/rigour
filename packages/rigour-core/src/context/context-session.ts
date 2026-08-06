/**
 * Per-project context session tracking.
 * Persists file reads and token estimates to .rigour/context-session.json.
 */

import { randomUUID } from 'crypto';
import fs from 'fs-extra';
import path from 'path';
import { hashContent } from './cache-engine.js';

function estimateTokens(text: string): number {
    if (!text) return 0;
    return Math.ceil(text.length / 4);
}

export interface FileReadRecord {
    path: string;
    contentHash: string;
    tokens: number;
    readAt: number;
}

export interface ContextSession {
    sessionId: string;
    createdAt: number;
    lastUpdatedAt: number;
    fileReads: Record<string, FileReadRecord>;
    totalTokens: number;
}

function getSessionPath(cwd: string): string {
    return path.join(cwd, '.rigour', 'context-session.json');
}

async function loadSession(cwd: string): Promise<ContextSession | null> {
    const sessionPath = getSessionPath(cwd);
    if (!await fs.pathExists(sessionPath)) return null;
    try {
        return await fs.readJson(sessionPath) as ContextSession;
    } catch {
        return null;
    }
}

async function saveSession(cwd: string, session: ContextSession): Promise<void> {
    const sessionPath = getSessionPath(cwd);
    await fs.ensureDir(path.dirname(sessionPath));
    await fs.writeJson(sessionPath, session, { spaces: 2 });
}

/**
 * Load existing session or create a new one for the project.
 */
export async function getOrCreateSession(cwd: string): Promise<ContextSession> {
    const resolved = path.resolve(cwd);
    const existing = await loadSession(resolved);
    if (existing) return existing;

    const session: ContextSession = {
        sessionId: `sess-${randomUUID()}`,
        createdAt: Date.now(),
        lastUpdatedAt: Date.now(),
        fileReads: {},
        totalTokens: 0,
    };
    await saveSession(resolved, session);
    return session;
}

/**
 * Record a file read in the current session, deduplicating by content hash.
 */
export async function recordFileRead(cwd: string, filePath: string, content: string): Promise<FileReadRecord> {
    const resolved = path.resolve(cwd);
    const session = await getOrCreateSession(resolved);
    const contentHash = hashContent(content);
    const tokens = estimateTokens(content);
    const normalizedPath = filePath.replace(/\\/g, '/');
    const existing = session.fileReads[normalizedPath];

    if (existing?.contentHash === contentHash) {
        return existing;
    }

    const record: FileReadRecord = {
        path: normalizedPath,
        contentHash,
        tokens,
        readAt: Date.now(),
    };

    if (existing) {
        session.totalTokens -= existing.tokens;
    }
    session.fileReads[normalizedPath] = record;
    session.totalTokens += tokens;
    session.lastUpdatedAt = Date.now();
    await saveSession(resolved, session);
    return record;
}
