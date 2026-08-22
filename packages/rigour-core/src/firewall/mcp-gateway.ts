/**
 * MCP Gateway interface sketch (ADR 001).
 * Full proxy packaging may move to packages/rigour-gateway later.
 */

import type { PolicyEvaluation } from './types.js';
import { CapabilityBroker, type BrokerConfig } from './capability-broker.js';

export interface ToolDescriptor {
    name: string;
    description?: string;
}

export interface McpGatewayInvokeRequest {
    agentId: string;
    taskId: string;
    tool: string;
    args: Record<string, unknown>;
    capabilityId?: string;
}

export interface McpGatewayInvokeResult {
    decision: PolicyEvaluation['decision'];
    reason: string;
    ruleId?: string;
    capabilityId?: string;
    /** Present only when decision is allow and a downstream handler is wired. */
    result?: unknown;
}

/**
 * In-process gateway that filters discovery and authorizes calls via CapabilityBroker.
 * Does not forward to external MCP servers yet — that is the next packaging step.
 */
export class McpGateway {
    private broker: CapabilityBroker;

    constructor(private readonly config: BrokerConfig & { downstream?: (tool: string, args: Record<string, unknown>) => Promise<unknown> }) {
        this.broker = new CapabilityBroker(config);
    }

    listTools(): ToolDescriptor[] {
        return this.config.toolAllowlist
            .filter(t => t !== '*')
            .map(name => ({ name, description: 'Allowlisted tool' }));
    }

    async invoke(req: McpGatewayInvokeRequest): Promise<McpGatewayInvokeResult> {
        const evaluation = this.broker.evaluateProposal({
            action: 'mcp.call',
            resource: req.tool,
            args: req.args,
            capabilityId: req.capabilityId,
        });
        if (evaluation.decision !== 'allow') {
            return {
                decision: evaluation.decision,
                reason: evaluation.reason,
                ruleId: evaluation.ruleId,
            };
        }
        let result: unknown;
        if (this.config.downstream) {
            result = await this.config.downstream(req.tool, req.args);
        }
        return {
            decision: 'allow',
            reason: evaluation.reason,
            ruleId: evaluation.ruleId,
            capabilityId: evaluation.capabilityId,
            result,
        };
    }

    leaseSecret(name: string, purpose: string): McpGatewayInvokeResult {
        const evaluation = this.broker.evaluateProposal({
            action: 'secret.lease',
            resource: name,
            args: { purpose },
        });
        return {
            decision: evaluation.decision,
            reason: evaluation.reason,
            ruleId: evaluation.ruleId,
            capabilityId: evaluation.capabilityId,
        };
    }

    getBroker(): CapabilityBroker {
        return this.broker;
    }
}
