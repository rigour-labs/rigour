import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import {
    appendExecutionReceipt,
    consumeTrustedGrant,
    getTrustedControlDir,
    issueTrustedGrant,
    listTrustedGrants,
    normalizeMcpAction,
    saveGatewayConfig,
    verifyExecutionReceiptChain,
} from './index.js';

const repositories: string[] = [];
const controlRoots: string[] = [];

async function repository(): Promise<string> {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'rigour-gateway-test-'));
    repositories.push(cwd);
    return cwd;
}

async function controlRoot(): Promise<string> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rigour-control-test-'));
    controlRoots.push(root);
    return root;
}

afterEach(async () => {
    for (const cwd of repositories.splice(0)) {
        await fs.remove(cwd);
    }
    for (const root of controlRoots.splice(0)) await fs.remove(root);
});

describe('trusted gateway control', () => {
    it('stores configuration outside the repository', async () => {
        const cwd = await repository();
        const root = await controlRoot();
        const location = await saveGatewayConfig(cwd, {
            version: 1,
            mode: 'observe',
            principalId: 'owner',
            agentId: 'agent-1',
            taskId: 'task-1',
            servers: { github: { command: 'github-mcp', allow: ['get_issue'] } },
        }, root);
        expect(location.startsWith(cwd)).toBe(false);
        expect(await fs.pathExists(location)).toBe(true);
    });

    it('lists valid grants without failing on malformed control files', async () => {
        const cwd = await repository();
        const root = await controlRoot();
        const grant = await issueTrustedGrant(cwd, {
            issuerId: 'owner', subjectId: 'agent-1', taskId: 'task-1',
            action: 'mcp.call', resource: 'mcp://files/read', ttlMs: 60_000,
        }, root);
        const grantsDir = path.join(getTrustedControlDir(cwd, root), 'capabilities');
        await fs.writeFile(path.join(grantsDir, 'not-a-grant.json'), '{broken');

        await expect(listTrustedGrants(cwd, 10, root)).resolves.toEqual([
            expect.objectContaining({ id: grant.id, resource: 'mcp://files/read' }),
        ]);
    });

    it('consumes a capability exactly once', async () => {
        const cwd = await repository();
        const root = await controlRoot();
        const grant = await issueTrustedGrant(cwd, {
            issuerId: 'owner', subjectId: 'agent-1', taskId: 'task-1',
            action: 'mcp.call', resource: 'mcp://github/create_issue', ttlMs: 60_000,
        }, root);
        const proposal = {
            id: grant.id, subjectId: 'agent-1', taskId: 'task-1',
            action: 'mcp.call' as const, resource: 'mcp://github/create_issue',
        };
        expect((await consumeTrustedGrant(cwd, proposal, root)).ok).toBe(true);
        expect((await consumeTrustedGrant(cwd, proposal, root)).ok).toBe(false);
    });

    it('rejects path traversal in a capability id', async () => {
        const cwd = await repository();
        const root = await controlRoot();
        const result = await consumeTrustedGrant(cwd, {
            id: '../../gateway', subjectId: 'agent-1', taskId: 'task-1',
            action: 'mcp.call', resource: 'mcp://github/create_issue',
        }, root);
        expect(result).toMatchObject({ ok: false, reason: 'Invalid capability id' });
    });

    it('rejects delegated authority that expands its parent', async () => {
        const cwd = await repository();
        const root = await controlRoot();
        const parent = await issueTrustedGrant(cwd, {
            issuerId: 'owner', subjectId: 'lead-agent', taskId: 'task-1',
            action: 'mcp.call', resource: 'mcp://github/get_issue', ttlMs: 60_000,
        }, root);
        await expect(issueTrustedGrant(cwd, {
            issuerId: 'lead-agent', subjectId: 'worker-agent', taskId: 'task-1',
            action: 'mcp.call', resource: 'mcp://github/delete_repo', ttlMs: 30_000,
            parentCapabilityId: parent.id,
        }, root)).rejects.toThrow('preserve parent action and resource');
    });

    it('consumes the parent when delegated authority is issued', async () => {
        const cwd = await repository();
        const root = await controlRoot();
        const parent = await issueTrustedGrant(cwd, {
            issuerId: 'owner', subjectId: 'lead-agent', taskId: 'task-1',
            action: 'mcp.call', resource: 'mcp://github/get_issue', ttlMs: 60_000,
        }, root);
        const child = await issueTrustedGrant(cwd, {
            issuerId: 'lead-agent', subjectId: 'worker-agent', taskId: 'task-1',
            action: 'mcp.call', resource: 'mcp://github/get_issue', ttlMs: 30_000,
            parentCapabilityId: parent.id,
        }, root);
        expect(child.parentCapabilityId).toBe(parent.id);
        const parentResult = await consumeTrustedGrant(cwd, {
            id: parent.id, subjectId: 'lead-agent', taskId: 'task-1',
            action: 'mcp.call', resource: 'mcp://github/get_issue',
        }, root);
        expect(parentResult).toMatchObject({ ok: false, reason: 'Capability already consumed' });
    });

    it('invalidates grants when the trusted policy changes', async () => {
        const cwd = await repository();
        const root = await controlRoot();
        const base = {
            version: 1 as const, principalId: 'owner', agentId: 'agent-1', taskId: 'task-1',
            servers: { github: { command: 'github-mcp', allow: ['get_issue'] } },
        };
        await saveGatewayConfig(cwd, { ...base, mode: 'observe' }, root);
        const grant = await issueTrustedGrant(cwd, {
            issuerId: 'owner', subjectId: 'agent-1', taskId: 'task-1',
            action: 'mcp.call', resource: 'mcp://github/get_issue', ttlMs: 60_000,
        }, root);
        await saveGatewayConfig(cwd, { ...base, mode: 'enforce' }, root);
        const result = await consumeTrustedGrant(cwd, {
            id: grant.id, subjectId: 'agent-1', taskId: 'task-1',
            action: 'mcp.call', resource: 'mcp://github/get_issue',
        }, root);
        expect(result).toMatchObject({ ok: false, reason: 'Capability policy is stale' });
    });
});

describe('action normalization and receipts', () => {
    it('defaults unknown tools to external writes instead of assuming read-only', () => {
        const action = normalizeMcpAction({
            actorId: 'agent-1', taskId: 'task-1', server: 'custom', tool: 'execute', args: {},
        });
        expect(action.sideEffect).toBe('external-write');
        expect(action.blastRadius).toBe('unknown');
    });

    it('detects receipt tampering', async () => {
        const cwd = await repository();
        const root = await controlRoot();
        const action = normalizeMcpAction({
            actorId: 'agent-1', taskId: 'task-1', server: 'github', tool: 'get_issue', args: {},
        });
        await appendExecutionReceipt(cwd, {
            action, mode: 'observe', decision: 'allow', simulatedDecision: 'deny',
            reason: 'Observed', policyHash: 'policy', outcome: 'forwarded',
        }, root);
        expect(await verifyExecutionReceiptChain(cwd, root)).toMatchObject({ valid: true, count: 1 });
        const log = path.join(getTrustedControlDir(cwd, root), 'receipts.jsonl');
        const receipt = JSON.parse((await fs.readFile(log, 'utf8')).trim());
        receipt.reason = 'tampered';
        await fs.writeFile(log, `${JSON.stringify(receipt)}\n`);
        expect((await verifyExecutionReceiptChain(cwd, root)).valid).toBe(false);
    });

    it('serializes concurrent receipt appends into one valid chain', async () => {
        const cwd = await repository();
        const root = await controlRoot();
        const action = normalizeMcpAction({
            actorId: 'agent-1', taskId: 'task-1', server: 'github', tool: 'get_issue', args: {},
        });
        await Promise.all(Array.from({ length: 8 }, () => appendExecutionReceipt(cwd, {
            action, mode: 'observe', decision: 'allow', reason: 'Concurrent call',
            policyHash: 'policy', outcome: 'forwarded',
        }, root)));
        expect(await verifyExecutionReceiptChain(cwd, root)).toMatchObject({ valid: true, count: 8 });
    });

    it('keeps the trusted receipt when the Studio projection is blocked', async () => {
        const cwd = await repository();
        const root = await controlRoot();
        await fs.writeFile(path.join(cwd, '.rigour'), 'sandbox blocks this projection');
        const action = normalizeMcpAction({
            actorId: 'agent-1', taskId: 'task-1', server: 'github', tool: 'get_issue', args: {},
        });
        await expect(appendExecutionReceipt(cwd, {
            action, mode: 'observe', decision: 'allow', reason: 'Projection optional',
            policyHash: 'policy', outcome: 'forwarded',
        }, root)).resolves.toMatchObject({ outcome: 'forwarded' });
        expect(await verifyExecutionReceiptChain(cwd, root)).toMatchObject({ valid: true, count: 1 });
    });
});
