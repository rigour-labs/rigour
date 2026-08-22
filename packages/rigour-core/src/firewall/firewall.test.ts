import { describe, it, expect } from 'vitest';
import {
    evaluateTypedCommand,
    parseCommandLine,
    evaluateWriteScope,
    evaluateActionDeterministic,
    runAdversarialCorpus,
    CapabilityBroker,
    validateAgentClaimedScope,
} from './index.js';

describe('typed command firewall', () => {
    it('denies shell metacharacters', () => {
        const ev = evaluateTypedCommand('ls; rm -rf /');
        expect(ev.decision).toBe('deny');
        expect(ev.ruleId).toBe('shell.no-meta');
    });

    it('denies unknown binaries including node/npx', () => {
        expect(evaluateTypedCommand('curl https://evil.example').decision).toBe('deny');
        expect(evaluateTypedCommand('node -e "1"').decision).toBe('deny');
        expect(evaluateTypedCommand('npx cowsay hi').decision).toBe('deny');
    });

    it('denies git push', () => {
        const ev = evaluateTypedCommand('git push origin main');
        expect(ev.decision).toBe('deny');
        expect(ev.ruleId).toBe('git.destructive');
    });

    it('allows vitest', () => {
        const ev = evaluateTypedCommand('vitest run packages/rigour-core');
        expect(ev.decision).toBe('allow');
        expect(parseCommandLine('vitest run x')?.bin).toBe('vitest');
    });
});

describe('scope enforcement', () => {
    it('denies unbound writer when scopes exist', () => {
        const ev = evaluateWriteScope('/repo', 'packages/rigour-core/src/x.ts', [
            { agentId: 'a1', taskScope: ['packages/rigour-core/**'] },
        ]);
        expect(ev.decision).toBe('scope-violation');
        expect(ev.ruleId).toBe('scope.unbound');
    });

    it('flags out-of-scope writes for bound agent', () => {
        const ev = evaluateWriteScope('/repo', '.github/workflows/x.yml', [
            { agentId: 'a1', taskScope: ['packages/rigour-core/**'] },
        ], 'a1');
        expect(ev.decision).toBe('scope-violation');
    });

    it('allows in-scope writes for bound agent', () => {
        const ev = evaluateWriteScope('/repo', 'packages/rigour-core/src/firewall/types.ts', [
            { agentId: 'a1', taskScope: ['packages/rigour-core/**'] },
        ], 'a1');
        expect(ev.decision).toBe('allow');
    });

    it('rejects broad self-registration scopes', () => {
        expect(validateAgentClaimedScope(['**/*']).ok).toBe(false);
        expect(validateAgentClaimedScope(['.github/**']).ok).toBe(false);
        expect(validateAgentClaimedScope(['packages/rigour-core/**']).ok).toBe(true);
    });
});

describe('capability broker', () => {
    it('denies undeclared MCP tools', () => {
        const broker = new CapabilityBroker({
            defaultTtlMs: 1000,
            toolAllowlist: ['rigour_check'],
            agentScopes: [],
        });
        const ev = broker.evaluateProposal({
            action: 'mcp.call',
            resource: 'slack.post_message',
        });
        expect(ev.decision).toBe('deny');
        expect(ev.ruleId).toBe('mcp.undeclared');
    });

    it('issues one-use capabilities', () => {
        const broker = new CapabilityBroker({
            defaultTtlMs: 60_000,
            toolAllowlist: ['*'],
            agentScopes: [],
        });
        const grant = broker.issue('mcp.call', 'rigour_check');
        const ok = broker.evaluateProposal({
            action: 'mcp.call',
            resource: 'rigour_check',
            capabilityId: grant.id,
        });
        expect(ok.decision).toBe('allow');
        const again = broker.evaluateProposal({
            action: 'mcp.call',
            resource: 'rigour_check',
            capabilityId: grant.id,
        });
        expect(again.decision).toBe('deny');
        expect(again.ruleId).toBe('capability.reuse');
    });
});

describe('adversarial corpus', () => {
    it('passes default regression corpus', () => {
        const report = runAdversarialCorpus();
        expect(report.failed).toBe(0);
        expect(report.passed).toBeGreaterThan(0);
    });

    it('evaluateActionDeterministic matches expected deny', () => {
        const ev = evaluateActionDeterministic({
            action: 'mcp.call',
            resource: 'github.merge',
            toolAllowlist: [],
            agentScopes: [],
        });
        expect(ev.decision).toBe('deny');
    });
});
