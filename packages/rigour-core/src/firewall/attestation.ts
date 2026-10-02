/**
 * Signed attestation bundles for completed transactions.
 * Keys prefer env / home directory — not agent-writable workspace keys for CI admit.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import fs from 'fs-extra';
import path from 'path';
import { execa } from 'execa';
import type { AttestationBundle, TransactionRecord } from './types.js';
import { rigourUserDir } from '../utils/user-state.js';

const KEY_FILE = 'attestation.key';

export async function resolveAttestationKey(cwd: string): Promise<{ key: Buffer; source: 'env' | 'home' | 'workspace' }> {
    const envKey = process.env.RIGOUR_ATTESTATION_KEY;
    if (envKey && envKey.length >= 32) {
        return { key: Buffer.from(envKey, 'utf8'), source: 'env' };
    }

    const homeKeyPath = path.join(rigourUserDir(), KEY_FILE);
    if (await fs.pathExists(homeKeyPath)) {
        return { key: await fs.readFile(homeKeyPath), source: 'home' };
    }

    const workspaceKeyPath = path.join(cwd, '.rigour', KEY_FILE);
    if (await fs.pathExists(workspaceKeyPath)) {
        return { key: await fs.readFile(workspaceKeyPath), source: 'workspace' };
    }

    // Create home key by default (outside agent workspace)
    await fs.ensureDir(rigourUserDir());
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
    const expected = Buffer.from(createHmac('sha256', key)
        .update(payloadForSign(rest) + signedAt)
        .digest('hex'));
    const given = Buffer.from(String(signature ?? ''));
    return expected.length === given.length && timingSafeEqual(expected, given);
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
 * CI admission. Admits only a bundle that is signed with a key outside the workspace, records PASS
 * gates, is fresh, is bound to this checkout (commit or tree, and at least one must be present and
 * match), whose artifact digest recomputes from the files here, and, when the caller names the
 * policy it requires, was produced under that policy.
 */
export async function admitForCi(cwd: string, options: { policyHash?: string } = {}): Promise<{ admit: boolean; reason: string }> {
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
    const requiredPolicy = options.policyHash ?? process.env.RIGOUR_REQUIRED_POLICY_HASH;
    if (requiredPolicy && bundle.policyHash !== requiredPolicy) {
        return { admit: false, reason: `Attestation policy ${bundle.policyHash} is not the required ${requiredPolicy}` };
    }

    const maxAgeMs = Number(process.env.RIGOUR_ATTESTATION_MAX_AGE_MS || 24 * 60 * 60 * 1000);
    const age = Date.now() - Date.parse(bundle.signedAt);
    if (!Number.isFinite(age) || age < 0 || age > maxAgeMs) {
        return { admit: false, reason: 'Attestation expired or has invalid signedAt' };
    }

    const binding = await checkBinding(cwd, bundle);
    if (binding) return { admit: false, reason: binding };
    if (await recomputeArtifactDigest(cwd, bundle) !== bundle.artifactDigest) {
        return { admit: false, reason: 'Attestation artifactDigest does not match the files in this checkout' };
    }

    return { admit: true, reason: 'Valid attestation with PASS gates, bound to this checkout, artifacts verified' };
}

/** Why the bundle is not bound to this checkout, or null when it is. A bundle bound to nothing is refused. */
async function checkBinding(cwd: string, bundle: AttestationBundle): Promise<string | null> {
    if (!bundle.commitSha && !bundle.treeDigest) return 'Attestation is bound to no commit or tree';
    const [headSha, headTree] = await Promise.all([getGitCommitSha(cwd), getGitTreeDigest(cwd)]);
    if (bundle.commitSha && bundle.commitSha !== headSha) {
        return `Attestation commitSha ${bundle.commitSha.slice(0, 8)} is not HEAD ${(headSha ?? 'none').slice(0, 8)}`;
    }
    if (bundle.treeDigest && bundle.treeDigest !== headTree) return 'Attestation treeDigest mismatch vs HEAD tree';
    return null;
}

/** The digest createAttestation would compute for this checkout: the named files' contents, or the tree. */
async function recomputeArtifactDigest(cwd: string, bundle: AttestationBundle): Promise<string> {
    const files = bundle.filesUsed ?? [];
    if (files.length === 0) return createHash('sha256').update(`tree:${bundle.treeDigest ?? ''}`).digest('hex');
    const contents = new Map<string, string>();
    for (const f of files) {
        const abs = path.resolve(cwd, f);
        if (!abs.startsWith(path.resolve(cwd) + path.sep)) continue; // never read outside the checkout
        if (await fs.pathExists(abs)) contents.set(f, await fs.readFile(abs, 'utf-8'));
    }
    return computeArtifactDigest(files, contents);
}
