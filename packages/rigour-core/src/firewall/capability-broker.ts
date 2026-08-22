/**
 * Capability broker — issues one-use, short-lived capabilities.
 */

import { randomUUID } from 'crypto';
import fs from 'fs-extra';
import path from 'path';
import type {
    CapabilityAction,
    CapabilityGrant,
    PolicyEvaluation,
} from './types.js';
import { hashPolicy } from './policy-hash.js';
import { evaluateTypedCommand } from './typed-command.js';
import { isPathInScope, type AgentScopeRecord } from './scope-enforcement.js';

export interface BrokerConfig {
    defaultTtlMs: number;
    toolAllowlist: string[];
    agentScopes: AgentScopeRecord[];
    agentId?: string;
    taskId?: string;
}

const DEFAULT_TTL_MS = 30_000;

export class CapabilityBroker {
    private grants = new Map<string, CapabilityGrant>();
    private decisions: PolicyEvaluation[] = [];
    private readonly policyHash: string;

    constructor(private readonly config: BrokerConfig) {
        this.policyHash = hashPolicy({
            toolAllowlist: [...config.toolAllowlist].sort(),
            scopes: config.agentScopes,
            ttl: config.defaultTtlMs ?? DEFAULT_TTL_MS,
        });
    }

    getPolicyHash(): string {
        return this.policyHash;
    }

    getDecisions(): PolicyEvaluation[] {
        return [...this.decisions];
    }

    listGrants(): CapabilityGrant[] {
        return [...this.grants.values()];
    }

    issue(action: CapabilityAction, resource: string, constraints?: Record<string, unknown>): CapabilityGrant {
        const grant: CapabilityGrant = {
            id: randomUUID(),
            action,
            resource,
            constraints,
            expiresAt: Date.now() + (this.config.defaultTtlMs ?? DEFAULT_TTL_MS),
            agentId: this.config.agentId,
            taskId: this.config.taskId,
            policyHash: this.policyHash,
            used: false,
        };
        this.grants.set(grant.id, grant);
        return grant;
    }

    evaluateProposal(input: {
        action: CapabilityAction;
        resource: string;
        args?: Record<string, unknown>;
        command?: string;
        capabilityId?: string;
    }): PolicyEvaluation {
        const timestamp = new Date().toISOString();
        const early = this.prechecks(input, timestamp);
        if (early) return early;

        if (input.capabilityId) {
            return this.evaluateWithCapability(input.capabilityId, input.action, input.resource, timestamp);
        }

        const grant = this.issue(input.action, input.resource, input.args);
        return this.record({
            decision: 'allow',
            reason: `Capability issued for ${input.action}:${input.resource}`,
            ruleId: 'capability.issue',
            capabilityId: grant.id,
            policyHash: this.policyHash,
            timestamp,
        });
    }

    private prechecks(
        input: {
            action: CapabilityAction;
            resource: string;
            args?: Record<string, unknown>;
            command?: string;
        },
        timestamp: string,
    ): PolicyEvaluation | null {
        if (input.action === 'mcp.call') {
            const deny = this.denyUndeclaredMcp(input.resource, timestamp);
            if (deny) return deny;
        }
        if (input.action === 'filesystem.write') {
            const deny = this.denyOutOfScopeWrite(input.resource, timestamp);
            if (deny) return deny;
        }
        if (input.action === 'shell.exec' && input.command) {
            const cmdEv = evaluateTypedCommand(input.command);
            if (cmdEv.decision !== 'allow') {
                return this.record({ ...cmdEv, policyHash: this.policyHash, timestamp });
            }
        }
        if (input.action === 'secret.lease') {
            const grant = this.issue('secret.lease', input.resource, { purpose: input.args?.purpose });
            return this.record({
                decision: 'allow',
                reason: `Secret lease capability issued for ${input.resource} (secret not exposed to agent)`,
                ruleId: 'secret.lease',
                capabilityId: grant.id,
                policyHash: this.policyHash,
                timestamp,
            });
        }
        return null;
    }

    private denyUndeclaredMcp(tool: string, timestamp: string): PolicyEvaluation | null {
        const allow = this.config.toolAllowlist;
        if (allow.includes('*') || allow.includes(tool)) return null;
        return this.record({
            decision: 'deny',
            reason: `MCP tool "${tool}" is not on the agent allowlist`,
            ruleId: 'mcp.undeclared',
            policyHash: this.policyHash,
            timestamp,
        });
    }

    private denyOutOfScopeWrite(resource: string, timestamp: string): PolicyEvaluation | null {
        if (this.config.agentScopes.length === 0) return null;
        if (!this.config.agentId) {
            return this.record({
                decision: 'scope-violation',
                reason: 'Writer agentId is required when agent scopes are registered (fail-closed; no union-allow)',
                ruleId: 'scope.unbound',
                policyHash: this.policyHash,
                timestamp,
            });
        }
        const agents = this.config.agentScopes.filter(a => a.agentId === this.config.agentId);
        const rel = resource.replace(/\\/g, '/');
        const ok = agents.some(a => isPathInScope(rel, a.taskScope));
        if (ok) return null;
        return this.record({
            decision: 'scope-violation',
            reason: `Write to "${resource}" outside assigned scope`,
            ruleId: 'scope.out-of-bounds',
            policyHash: this.policyHash,
            timestamp,
        });
    }

    private evaluateWithCapability(
        capabilityId: string,
        action: CapabilityAction,
        resource: string,
        timestamp: string,
    ): PolicyEvaluation {
        const consumed = this.consumeCapability(capabilityId, action, resource, timestamp);
        if (consumed.kind === 'deny') return consumed.evaluation;
        return this.record({
            decision: 'allow',
            reason: `Capability ${capabilityId} consumed for ${action}:${resource}`,
            ruleId: 'capability.consume',
            capabilityId,
            policyHash: this.policyHash,
            timestamp,
        });
    }

    private consumeCapability(
        capabilityId: string,
        action: CapabilityAction,
        resource: string,
        timestamp: string,
    ): { kind: 'deny'; evaluation: PolicyEvaluation } | { kind: 'ok' } {
        const grant = this.grants.get(capabilityId);
        if (!grant) {
            return { kind: 'deny', evaluation: this.denyCap('Unknown capability id', 'capability.unknown', timestamp) };
        }
        if (grant.used) {
            return {
                kind: 'deny',
                evaluation: this.denyCap('Capability already consumed (one-use)', 'capability.reuse', timestamp, grant.id),
            };
        }
        if (Date.now() > grant.expiresAt) {
            return {
                kind: 'deny',
                evaluation: this.denyCap('Capability expired', 'capability.expired', timestamp, grant.id),
            };
        }
        if (grant.action !== action || grant.resource !== resource) {
            return {
                kind: 'deny',
                evaluation: this.denyCap(
                    'Capability does not match proposed action/resource',
                    'capability.mismatch',
                    timestamp,
                    grant.id,
                ),
            };
        }
        grant.used = true;
        return { kind: 'ok' };
    }

    private denyCap(reason: string, ruleId: string, timestamp: string, capabilityId?: string): PolicyEvaluation {
        return this.record({
            decision: 'deny',
            reason,
            ruleId,
            capabilityId,
            policyHash: this.policyHash,
            timestamp,
        });
    }

    private record(ev: PolicyEvaluation): PolicyEvaluation {
        this.decisions.push(ev);
        return ev;
    }

    async persistDecisions(cwd: string): Promise<void> {
        const dir = path.join(cwd, '.rigour');
        await fs.ensureDir(dir);
        const file = path.join(dir, 'firewall-decisions.jsonl');
        const lines = this.decisions.map(d => JSON.stringify(d)).join('\n');
        if (lines) {
            await fs.appendFile(file, lines + '\n');
        }
    }
}

/** Pure evaluate for adversarial replay (fresh broker per call). */
export function evaluateActionDeterministic(input: {
    action: CapabilityAction;
    resource: string;
    command?: string;
    toolAllowlist: string[];
    agentScopes: AgentScopeRecord[];
    agentId?: string;
}): PolicyEvaluation {
    const broker = new CapabilityBroker({
        defaultTtlMs: DEFAULT_TTL_MS,
        toolAllowlist: input.toolAllowlist,
        agentScopes: input.agentScopes,
        agentId: input.agentId,
    });
    return broker.evaluateProposal({
        action: input.action,
        resource: input.resource,
        command: input.command,
    });
}
