/**
 * Signed attestation bundles for completed transactions.
 * Keys prefer env / home directory — not agent-writable workspace keys for CI admit.
 */

import { createHash, createHmac, randomBytes } from 'crypto';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { execa } from 'execa';
import type { AttestationBundle, TransactionRecord } from './types.js';

const KEY_FILE = 'attestation.key';

export async function resolveAttestationKey(cwd: string): Promise<{ key: Buffer; source: 'env' | 'home' | 'workspace' }> {
    const envKey = process.env.RIGOUR_ATTESTATION_KEY;
    if (envKey && envKey.length >= 32) {
        return { key: Buffer.from(envKey, 'utf8'), source: 'env' };
    }

    const homeKeyPath = path.join(os.homedir(), '.rigour', KEY_FILE);
    if (await fs.pathExists(homeKeyPath)) {
        return { key: await fs.readFile(homeKeyPath), source: 'home' };
    }

    const workspaceKeyPath = path.join(cwd, '.rigour', KEY_FILE);
    if (await fs.pathExists(workspaceKeyPath)) {
        return { key: await fs.readFile(workspaceKeyPath), source: 'workspace' };
    }

    // Create home key by default (outside agent workspace)
    await fs.ensureDir(path.join(os.homedir(), '.rigour'));
    const key = randomBytes(32);
    await fs.writeFile(homeKeyPath, key, { mode: 0o600 });
    return { key, source: 'home' };
}

/** @deprecated use resolveAttestationKey */
export async function ensureAttestationKey(cwd: string): Promise<Buffer> {
    const { key } = await resolveAttestationKey(cwd);
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
        commitSha: bundle.commitSha,
        treeDigest: bundle.treeDigest,
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

export async function getGitCommitSha(dir: string): Promise<string | null> {
    try {
        const { stdout } = await execa('git', ['rev-parse', 'HEAD'], { cwd: dir, shell: false });
        return stdout.trim() || null;
    } catch {
        return null;
    }
}

export async function getGitTreeDigest(dir: string): Promise<string | null> {
    try {
        const { stdout } = await execa('git', ['rev-parse', 'HEAD^{tree}'], { cwd: dir, shell: false });
        return stdout.trim() || null;
    } catch {
        return null;
    }
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
        commitSha?: string;
        treeDigest?: string;
        verifyRoot?: string;
    },
): Promise<AttestationBundle> {
    const { key } = await resolveAttestationKey(cwd);
    const verifyRoot = input.verifyRoot || input.transaction.worktreePath || cwd;
    const commitSha = input.commitSha ?? (await getGitCommitSha(verifyRoot)) ?? undefined;
    const treeDigest = input.treeDigest ?? (await getGitTreeDigest(verifyRoot)) ?? undefined;

    const files = input.transaction.filesChanged;
    const contents = input.fileContents ?? new Map<string, string>();
    if (files.length > 0 && contents.size === 0) {
        for (const f of files) {
            const abs = path.join(verifyRoot, f);
            if (await fs.pathExists(abs)) {
                contents.set(f, await fs.readFile(abs, 'utf-8'));
            }
        }
    }

    let artifactDigest = computeArtifactDigest(files, contents);
    if (files.length === 0 && treeDigest) {
        artifactDigest = createHash('sha256').update(`tree:${treeDigest}`).digest('hex');
    }
    if (!treeDigest && files.length === 0) {
        throw new Error('Attestation requires treeDigest or non-empty filesChanged with contents');
    }

    const unsigned: Omit<AttestationBundle, 'signature' | 'signedAt'> = {
        version: 1,
        transactionId: input.transaction.id,
        agentId: input.transaction.agentId,
        userId: input.userId,
        scope: input.transaction.scope,
        policyHash: input.transaction.policyHash,
        capabilities: input.transaction.capabilitiesIssued,
        filesUsed: files,
        toolsUsed: input.toolsUsed ?? [],
        gateResults: input.gateResults,
        overrides: input.overrides ?? [],
        artifactDigest,
        commitSha,
        treeDigest,
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
    const { key } = await resolveAttestationKey(cwd);
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
 * CI admission: valid signature, PASS gates, bound commit/tree, fresh, non-workspace-key unless allowed.
 */
export async function admitForCi(cwd: string): Promise<{ admit: boolean; reason: string }> {
    const { source } = await resolveAttestationKey(cwd);
    if (source === 'workspace' && process.env.RIGOUR_ALLOW_WORKSPACE_ATTESTATION_KEY !== '1') {
        return {
            admit: false,
            reason: 'Attestation key is workspace-local; set RIGOUR_ATTESTATION_KEY or ~/.rigour/attestation.key',
        };
    }

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
    if (!bundle.treeDigest && (!bundle.filesUsed || bundle.filesUsed.length === 0)) {
        return { admit: false, reason: 'Attestation missing treeDigest and filesUsed' };
    }
    if (!bundle.artifactDigest || bundle.artifactDigest.length < 16) {
        return { admit: false, reason: 'Attestation artifactDigest missing or trivial' };
    }

    const maxAgeMs = Number(process.env.RIGOUR_ATTESTATION_MAX_AGE_MS || 24 * 60 * 60 * 1000);
    const age = Date.now() - Date.parse(bundle.signedAt);
    if (!Number.isFinite(age) || age < 0 || age > maxAgeMs) {
        return { admit: false, reason: 'Attestation expired or has invalid signedAt' };
    }

    const headSha = await getGitCommitSha(cwd);
    if (bundle.commitSha && headSha && bundle.commitSha !== headSha) {
        return {
            admit: false,
            reason: `Attestation commitSha ${bundle.commitSha.slice(0, 8)}≠ HEAD ${headSha.slice(0, 8)}`,
        };
    }
    const headTree = await getGitTreeDigest(cwd);
    if (bundle.treeDigest && headTree && bundle.treeDigest !== headTree) {
        return {
            admit: false,
            reason: `Attestation treeDigest mismatch vs HEAD tree`,
        };
    }

    return { admit: true, reason: 'Valid attestation with PASS gates and bound tree/commit' };
}
