/**
 * One-time arbitration tokens — bind a Studio approve/reject to the MCP process that asked.
 *
 * The token lives only in the requesting process's memory and in a store outside the workspace
 * (never in .rigour/ or the event log, which agents write). Studio consumes it once and signs the
 * decision with it; the requester accepts only a decision whose signature verifies, so appending
 * a decision line to .rigour/events.jsonl approves nothing.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import fs from 'fs-extra';
import path from 'path';
import { repoStateDir } from '../utils/user-state.js';

export type ArbitrationDecision = 'approve' | 'reject';

interface TokenEntry {
    token: string;
    expiresAt: number;
}

type TokenStore = Record<string, TokenEntry>;

function storePath(cwd: string): string {
    return path.join(repoStateDir(cwd), 'arbitration-tokens.json');
}

async function readStore(cwd: string): Promise<TokenStore> {
    try {
        return await fs.readJson(storePath(cwd));
    } catch {
        return {};
    }
}

async function writeStore(cwd: string, store: TokenStore): Promise<void> {
    await fs.ensureDir(path.dirname(storePath(cwd)), { mode: 0o700 });
    await fs.writeJson(storePath(cwd), store, { spaces: 2, mode: 0o600 });
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

function decisionProof(token: string, requestId: string, decision: ArbitrationDecision): string {
    return createHmac('sha256', token).update(`${requestId}:${decision}`).digest('hex');
}

/**
 * Studio side: consume the request's token once and sign the human's decision with it.
 * Null when the request is unknown, expired or already decided.
 */
export async function signArbitrationDecision(cwd: string, requestId: string, decision: ArbitrationDecision): Promise<string | null> {
    if (!requestId) return null;
    const store = await readStore(cwd);
    const entry = store[requestId];
    if (!entry) return null;
    delete store[requestId];
    await writeStore(cwd, store);
    return Date.now() > entry.expiresAt ? null : decisionProof(entry.token, requestId, decision);
}

/** Requester side: true only for a decision signed with the token this process issued. */
export function verifyArbitrationDecision(token: string, requestId: string, decision: unknown, proof: unknown): boolean {
    if ((decision !== 'approve' && decision !== 'reject') || typeof proof !== 'string') return false;
    const expected = Buffer.from(decisionProof(token, requestId, decision));
    const given = Buffer.from(proof);
    return expected.length === given.length && timingSafeEqual(expected, given);
}
