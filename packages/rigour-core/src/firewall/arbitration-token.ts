/**
 * One-time arbitration tokens — bind Studio approve/reject to the requesting MCP process.
 */

import { randomBytes, timingSafeEqual } from 'crypto';
import fs from 'fs-extra';
import path from 'path';

interface TokenEntry {
    token: string;
    expiresAt: number;
}

type TokenStore = Record<string, TokenEntry>;

function storePath(cwd: string): string {
    return path.join(cwd, '.rigour', 'arbitration-tokens.json');
}

async function readStore(cwd: string): Promise<TokenStore> {
    const p = storePath(cwd);
    if (!(await fs.pathExists(p))) return {};
    try {
        return await fs.readJson(p);
    } catch {
        return {};
    }
}

async function writeStore(cwd: string, store: TokenStore): Promise<void> {
    await fs.ensureDir(path.join(cwd, '.rigour'));
    await fs.writeJson(storePath(cwd), store, { spaces: 2 });
}

export async function issueArbitrationToken(cwd: string, requestId: string, ttlMs = 60_000): Promise<string> {
    const token = randomBytes(24).toString('hex');
    const store = await readStore(cwd);
    const now = Date.now();
    for (const [k, v] of Object.entries(store)) {
        if (v.expiresAt < now) delete store[k];
    }
    store[requestId] = { token, expiresAt: now + ttlMs };
    await writeStore(cwd, store);
    return token;
}

/**
 * Consume a one-time token. Returns false if missing, expired, or mismatched.
 */
export async function consumeArbitrationToken(
    cwd: string,
    requestId: string,
    token: string | undefined,
): Promise<boolean> {
    if (!token || !requestId) return false;
    const store = await readStore(cwd);
    const entry = store[requestId];
    if (!entry) return false;
    if (Date.now() > entry.expiresAt) {
        delete store[requestId];
        await writeStore(cwd, store);
        return false;
    }
    const a = Buffer.from(entry.token);
    const b = Buffer.from(token);
    const ok = a.length === b.length && timingSafeEqual(a, b);
    delete store[requestId];
    await writeStore(cwd, store);
    return ok;
}
