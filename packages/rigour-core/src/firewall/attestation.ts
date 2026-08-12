/**
 * Signed attestation bundles for completed transactions.
 */

import { createHash, createHmac, randomBytes } from 'crypto';
import fs from 'fs-extra';
import path from 'path';
import type { AttestationBundle, TransactionRecord } from './types.js';

const KEY_FILE = 'attestation.key';

export async function ensureAttestationKey(cwd: string): Promise<Buffer> {
    const dir = path.join(cwd, '.rigour');
    await fs.ensureDir(dir);
    const keyPath = path.join(dir, KEY_FILE);
    if (await fs.pathExists(keyPath)) {
        return await fs.readFile(keyPath);
    }
    const key = randomBytes(32);
    await fs.writeFile(keyPath, key);
    return key;
}

function payloadForSign(bundle: Omit<AttestationBundle, 'signature' | 'signedAt'>): string {
    return JSON.stringify({
        version: bundle.version,
        transactionId: bundle.transactionId,
        agentId: bundle.agentId,
        userId: bundle.userId,
        scope: bundle.scope,
        policyHash: bundle.policyHash,
        capabilities: bundle.capabilities,
        filesUsed: bundle.filesUsed,
        toolsUsed: bundle.toolsUsed,
        gateResults: bundle.gateResults,
        overrides: bundle.overrides,
        artifactDigest: bundle.artifactDigest,
    });
}

export function computeArtifactDigest(files: string[], contents: Map<string, string>): string {
    const h = createHash('sha256');
    for (const f of [...files].sort()) {
        h.update(f);
        h.update('\0');
        h.update(contents.get(f) ?? '');
        h.update('\0');
    }
    return h.digest('hex');
}

export async function createAttestation(
    cwd: string,
    input: {
        transaction: TransactionRecord;
        gateResults: { status: string; score?: number; failedGates: string[] };
        toolsUsed?: string[];
        overrides?: string[];
        userId?: string;
        fileContents?: Map<string, string>;
    },
): Promise<AttestationBundle> {
    const key = await ensureAttestationKey(cwd);
    const artifactDigest = computeArtifactDigest(
        input.transaction.filesChanged,
        input.fileContents ?? new Map(),
    );
    const unsigned: Omit<AttestationBundle, 'signature' | 'signedAt'> = {
        version: 1,
        transactionId: input.transaction.id,
        agentId: input.transaction.agentId,
        userId: input.userId,
        scope: input.transaction.scope,
        policyHash: input.transaction.policyHash,
        capabilities: input.transaction.capabilitiesIssued,
        filesUsed: input.transaction.filesChanged,
        toolsUsed: input.toolsUsed ?? [],
        gateResults: input.gateResults,
        overrides: input.overrides ?? [],
        artifactDigest,
    };
    const signedAt = new Date().toISOString();
    const signature = createHmac('sha256', key)
        .update(payloadForSign(unsigned) + signedAt)
        .digest('hex');

    const bundle: AttestationBundle = { ...unsigned, signedAt, signature };
    const outDir = path.join(cwd, '.rigour', 'attestations');
    await fs.ensureDir(outDir);
    await fs.writeJson(path.join(outDir, `${bundle.transactionId}.json`), bundle, { spaces: 2 });
    await fs.writeJson(path.join(cwd, '.rigour', 'attestation-latest.json'), bundle, { spaces: 2 });
    return bundle;
}

export async function verifyAttestation(cwd: string, bundle: AttestationBundle): Promise<boolean> {
    const key = await ensureAttestationKey(cwd);
    const { signature, signedAt, ...rest } = bundle;
    const expected = createHmac('sha256', key)
        .update(payloadForSign(rest) + signedAt)
        .digest('hex');
    return expected === signature;
}

export async function loadLatestAttestation(cwd: string): Promise<AttestationBundle | null> {
    const p = path.join(cwd, '.rigour', 'attestation-latest.json');
    if (!(await fs.pathExists(p))) return null;
    try {
        return await fs.readJson(p);
    } catch {
        return null;
    }
}

/**
 * CI admission: require valid attestation + PASS gates.
 */
export async function admitForCi(cwd: string): Promise<{ admit: boolean; reason: string }> {
    const bundle = await loadLatestAttestation(cwd);
    if (!bundle) {
        return { admit: false, reason: 'No attestation bundle found' };
    }
    const valid = await verifyAttestation(cwd, bundle);
    if (!valid) {
        return { admit: false, reason: 'Attestation signature invalid' };
    }
    if (bundle.gateResults.status !== 'PASS') {
        return { admit: false, reason: `Gates not PASS (${bundle.gateResults.status})` };
    }
    return { admit: true, reason: 'Valid attestation with PASS gates' };
}
