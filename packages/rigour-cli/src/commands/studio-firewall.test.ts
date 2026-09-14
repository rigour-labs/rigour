import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { getTrustedControlDir } from '@rigour-labs/core';
import { getGatewayMediationState, loadStudioGatewayEvidence, summarizeGatewayEvidence } from './studio-firewall.js';

const temporaryPaths: string[] = [];

afterEach(async () => {
    await Promise.all(temporaryPaths.splice(0).map((target) => fs.remove(target)));
});

describe('Studio gateway evidence', () => {
    it('does not expose downstream commands, environment secrets, or receipt signatures', () => {
        const payload = summarizeGatewayEvidence({
            config: {
                version: 1, mode: 'observe', principalId: 'owner', agentId: 'agent-1', taskId: 'task-1',
                servers: { github: { command: 'secret-command', allow: ['get_issue'], env: { TOKEN: 'secret-value' } } },
            },
            receipts: [{
                version: 1, id: 'receipt-1', repositoryId: 'repo-1', mode: 'observe', decision: 'allow', outcome: 'forwarded',
                reason: 'forwarded', policyHash: 'policy', createdAt: '2026-01-01T00:00:00Z', digest: 'private-digest', signature: 'private-signature',
                action: { version: 1, actorId: 'agent-1', taskId: 'task-1', channel: 'mcp', operation: 'github__get_issue', resource: 'mcp://github/get_issue', environment: 'local', sideEffect: 'read', reversibility: 'high', sensitivity: 'normal', blastRadius: 'single-resource' },
            }],
            capabilities: [],
            chain: { valid: true, count: 1 },
        });
        const serialized = JSON.stringify(payload);
        expect(serialized).not.toContain('secret-command');
        expect(serialized).not.toContain('secret-value');
        expect(serialized).not.toContain('private-signature');
        expect(serialized).not.toContain('private-digest');
    });

    it('returns a degraded payload for invalid trusted configuration', async () => {
        const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'rigour-studio-repo-'));
        const controlRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rigour-studio-control-'));
        temporaryPaths.push(cwd, controlRoot);
        const trustedDir = getTrustedControlDir(cwd, controlRoot);
        await fs.ensureDir(trustedDir);
        await fs.writeJson(path.join(trustedDir, 'gateway.json'), { version: 99 });

        const evidence = await loadStudioGatewayEvidence(cwd, controlRoot);
        expect(evidence.config).toBeNull();
        expect(evidence.configurationError).toContain('version must be 1');
        expect(summarizeGatewayEvidence(evidence)).toMatchObject({ configured: false });
    });

    it('does not claim configured gateways are observed before receipts exist', () => {
        const gateway = summarizeGatewayEvidence({
            config: {
                version: 1, mode: 'observe', principalId: 'owner', agentId: 'agent-1', taskId: 'task-1',
                servers: { github: { command: 'mcp-server', allow: ['get_issue'] } },
            },
            receipts: [],
            capabilities: [],
            chain: { valid: true, count: 0 },
        });
        expect(getGatewayMediationState(gateway)).toBe('configured');
        expect(getGatewayMediationState(summarizeGatewayEvidence({
            config: null,
            receipts: [],
            capabilities: [],
            chain: { valid: true, count: 0 },
        }))).toBe('not_configured');
    });
});
