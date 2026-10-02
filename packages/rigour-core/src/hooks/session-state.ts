/**
 * What the agent hooks remember per session, kept outside the workspace (utils/user-state.ts)
 * so the agent being reviewed cannot rewrite it:
 *   - baseline: the commit HEAD was at when the session first edited a file. The stop review
 *     covers everything since then, so committing mid-session hides nothing.
 *   - attempts: how many times the stop review has blocked this session.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { repoStateDir } from '../utils/user-state.js';

interface SessionEntry {
    baseline?: string;
    attempts?: number;
    at: number;
}

type SessionStore = Record<string, SessionEntry>;

/** Sessions untouched this long are forgotten, so the store stays small. */
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function storePath(cwd: string): string {
    return path.join(repoStateDir(cwd), 'sessions.json');
}

function readStore(cwd: string): SessionStore {
    try {
        return JSON.parse(fs.readFileSync(storePath(cwd), 'utf8'));
    } catch {
        return {};
    }
}

function update(cwd: string, session: string, change: (entry: SessionEntry) => SessionEntry): SessionEntry {
    const store = readStore(cwd);
    const now = Date.now();
    for (const [id, entry] of Object.entries(store)) if (now - entry.at > SESSION_TTL_MS) delete store[id];
    store[session] = { ...change(store[session] ?? { at: now }), at: now };
    fs.mkdirSync(path.dirname(storePath(cwd)), { recursive: true, mode: 0o700 });
    fs.writeFileSync(storePath(cwd), JSON.stringify(store), { mode: 0o600 });
    return store[session];
}

/** Record where the session started, once; later calls keep the first commit. */
export function recordSessionBaseline(cwd: string, session: string): void {
    if (!session || readStore(cwd)[session]?.baseline) return;
    const head = spawnSync('git', ['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd, encoding: 'utf8' });
    if (head.status !== 0) return; // no commits yet: the working-tree review already covers everything
    update(cwd, session, entry => ({ ...entry, baseline: head.stdout.trim() }));
}

/** The commit the session started from, if it is still in history (a rebase can drop it). */
export function sessionBaseline(cwd: string, session: string): string | undefined {
    const baseline = readStore(cwd)[session]?.baseline;
    if (!baseline) return undefined;
    const known = spawnSync('git', ['cat-file', '-e', `${baseline}^{commit}`], { cwd });
    return known.status === 0 ? baseline : undefined;
}

/** This stop's attempt number: blocks so far plus one. */
export function nextStopAttempt(cwd: string, session: string): number {
    return update(cwd, session, entry => ({ ...entry, attempts: (entry.attempts ?? 0) + 1 })).attempts ?? 1;
}

/** The agent finished cleanly: the next stop starts counting again. The baseline stays. */
export function clearStopAttempts(cwd: string, session: string): void {
    if (readStore(cwd)[session]?.attempts) update(cwd, session, entry => ({ ...entry, attempts: 0 }));
}
