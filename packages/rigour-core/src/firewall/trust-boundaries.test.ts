import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { issueArbitrationToken, signArbitrationDecision, verifyArbitrationDecision } from './arbitration-token.js';
import { admitForCi, createAttestation } from './attestation.js';
import type { TransactionRecord } from './types.js';

let repo: string;
const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });

beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'trust-'));
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 't');
    git('config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 1;\n');
    git('add', '-A');
    git('commit', '-qm', 'init');
});
afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

describe('human arbitration', () => {
    it('accepts only a decision signed with the issued token, once', async () => {
        const token = await issueArbitrationToken(repo, 'r1');
        expect(fs.existsSync(path.join(repo, '.rigour', 'arbitration-tokens.json'))).toBe(false);
        // A line any process can append to the event log carries no valid proof.
        expect(verifyArbitrationDecision(token, 'r1', 'approve', undefined)).toBe(false);
        expect(verifyArbitrationDecision(token, 'r1', 'approve', 'f'.repeat(64))).toBe(false);
        const proof = await signArbitrationDecision(repo, 'r1', 'approve');
        expect(verifyArbitrationDecision(token, 'r1', 'approve', proof)).toBe(true);
        expect(verifyArbitrationDecision(token, 'r1', 'reject', proof)).toBe(false);
        expect(await signArbitrationDecision(repo, 'r1', 'approve')).toBeNull();
    });
});

describe('CI admission', () => {
    const tx = (over: Partial<TransactionRecord> = {}) => ({
        id: 'tx1', agentId: 'agent', scope: ['**/*'], policyHash: 'policy-a', capabilitiesIssued: [], filesChanged: ['a.ts'], ...over,
    }) as unknown as TransactionRecord;
    const pass = { status: 'PASS', failedGates: [] };

    it('admits a fresh, bound bundle whose files are unchanged', async () => {
        await createAttestation(repo, { transaction: tx(), gateResults: pass });
        expect(await admitForCi(repo)).toMatchObject({ admit: true });
    });

    it('refuses when an attested file differs from what was signed, even at the same commit', async () => {
        await createAttestation(repo, { transaction: tx(), gateResults: pass });
        fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 2;\n'); // HEAD and its tree are unchanged
        expect(await admitForCi(repo)).toMatchObject({ admit: false, reason: expect.stringContaining('artifactDigest') });
    });

    it('refuses a bundle produced under another policy than the one required', async () => {
        await createAttestation(repo, { transaction: tx(), gateResults: pass });
        expect(await admitForCi(repo, { policyHash: 'policy-b' })).toMatchObject({ admit: false });
        expect(await admitForCi(repo, { policyHash: 'policy-a' })).toMatchObject({ admit: true });
    });

    it('refuses a bundle bound to no commit or tree', async () => {
        const noRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'trust-norepo-'));
        try {
            fs.writeFileSync(path.join(noRepo, 'a.ts'), 'export const a = 1;\n');
            await createAttestation(noRepo, { transaction: tx(), gateResults: pass });
            expect(await admitForCi(noRepo)).toMatchObject({ admit: false, reason: 'Attestation is bound to no commit or tree' });
        } finally {
            fs.rmSync(noRepo, { recursive: true, force: true });
        }
    });
});
