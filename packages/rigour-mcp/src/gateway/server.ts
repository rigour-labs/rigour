import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import {
    appendExecutionReceipt,
    consumeTrustedGrant,
    getGatewayPolicyHash,
    loadGatewayConfig,
    normalizeMcpAction,
    type FirewallDecision,
    type GatewayControlConfig,
} from '@rigour-labs/core';
import { DownstreamRegistry, splitGatewayTool } from './runtime.js';

function denied(message: string) {
    return { isError: true, content: [{ type: 'text' as const, text: `Rigour denied this action: ${message}` }] };
}

function failed(message: string) {
    return { isError: true, content: [{ type: 'text' as const, text: message }] };
}

function authorize(cwd: string, config: GatewayControlConfig, capabilityId: string | undefined, resource: string) {
    if (!capabilityId) return { ok: false, reason: 'Explicit capability is required' };
    return consumeTrustedGrant(cwd, {
        id: capabilityId,
        subjectId: config.agentId,
        taskId: config.taskId,
        action: 'mcp.call',
        resource,
    });
}

interface GatewayContext {
    cwd: string;
    config: GatewayControlConfig;
    downstream: DownstreamRegistry;
    policyHash: string;
}

interface PreparedCall {
    target: { server: string; tool: string } | null;
    args: Record<string, unknown>;
    capabilityId?: string;
    action: ReturnType<typeof normalizeMcpAction>;
}

function prepareCall(request: CallToolRequest, context: GatewayContext): PreparedCall {
    const target = splitGatewayTool(request.params.name, Object.keys(context.config.servers));
    const rawArgs = (request.params.arguments ?? {}) as Record<string, unknown>;
    const capabilityId = typeof rawArgs._rigourCapability === 'string' ? rawArgs._rigourCapability : undefined;
    const args = { ...rawArgs };
    delete args._rigourCapability;
    const actionTarget = target ?? { server: 'gateway', tool: request.params.name };
    const action = normalizeMcpAction({
        actorId: context.config.agentId,
        taskId: context.config.taskId,
        server: actionTarget.server,
        tool: actionTarget.tool,
        args,
    });
    return { target, args, capabilityId, action };
}

function toolIsAllowed(context: GatewayContext, target: { server: string; tool: string }): boolean {
    const allowed = context.config.servers[target.server].allow;
    return allowed.includes('*') || allowed.includes(target.tool);
}

function authorizationDecision(config: GatewayControlConfig, authorization: { ok: boolean; reason: string }) {
    const mustDeny = config.mode === 'enforce' && !authorization.ok;
    return {
        mustDeny,
        decision: (mustDeny ? 'deny' : 'allow') as FirewallDecision,
        simulatedDecision: config.mode === 'observe' && !authorization.ok ? 'deny' as const : undefined,
        reason: authorization.ok
            ? authorization.reason
            : config.mode === 'observe'
                ? `Observe mode: would deny because ${authorization.reason}`
                : authorization.reason,
    };
}

async function recordDenial(context: GatewayContext, input: {
    action: ReturnType<typeof normalizeMcpAction>;
    reason: string;
    capabilityId?: string;
}) {
    await appendExecutionReceipt(context.cwd, {
        action: input.action,
        mode: context.config.mode,
        decision: 'deny',
        reason: input.reason,
        capabilityId: input.capabilityId,
        policyHash: context.policyHash,
        outcome: 'denied',
    });
    return denied(input.reason);
}

async function handleGatewayCall(request: CallToolRequest, context: GatewayContext) {
    const { target, args, capabilityId, action } = prepareCall(request, context);
    if (!target) return recordDenial(context, { action, capabilityId, reason: `Unknown gateway tool ${request.params.name}` });

    if (!toolIsAllowed(context, target)) {
        return recordDenial(context, {
            action, capabilityId, reason: `Tool ${request.params.name} is not allowed by the trusted gateway configuration`,
        });
    }

    const authorization = await authorize(context.cwd, context.config, capabilityId, action.resource);
    const { mustDeny, decision, simulatedDecision, reason } = authorizationDecision(context.config, authorization);
    if (mustDeny) return recordDenial(context, { action, capabilityId, reason });

    let result;
    try {
        result = await context.downstream.call(target.server, target.tool, args);
    } catch (error: any) {
        const failure = `${reason}; downstream failed before returning a result: ${error?.message ?? String(error)}`;
        await appendExecutionReceipt(context.cwd, {
            action, mode: context.config.mode, decision, simulatedDecision, reason: failure,
            capabilityId, policyHash: context.policyHash, outcome: 'failed',
        });
        return failed(failure);
    }

    try {
        const outcome = result.isError ? 'failed' as const : 'forwarded' as const;
        const receipt = await appendExecutionReceipt(context.cwd, {
            action, mode: context.config.mode, decision, simulatedDecision,
            reason: result.isError ? `${reason}; downstream returned an error result` : reason,
            capabilityId, policyHash: context.policyHash, outcome,
        });
        return { ...result, _meta: { ...(result._meta ?? {}), rigourReceiptId: receipt.id } };
    } catch (error: any) {
        return failed(`Downstream action returned, but Rigour could not record its receipt: ${error?.message ?? String(error)}. Treat the external outcome as unknown and inspect the downstream system.`);
    }
}

export async function runGatewayServer(cwd: string): Promise<void> {
    const config = await loadGatewayConfig(cwd);
    if (!config) throw new Error('Gateway is not configured. Run `rigour firewall gateway-configure --config <file>`.');
    const downstream = new DownstreamRegistry(config, cwd);
    await downstream.connect();
    const server = new Server({ name: 'rigour-mcp-gateway', version: '1.0.0' }, { capabilities: { tools: {} } });
    const policyHash = getGatewayPolicyHash(cwd, config);
    const context = { cwd, config, downstream, policyHash };

    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: await downstream.listTools() }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => handleGatewayCall(request, context));

    const shutdown = async () => {
        await downstream.close();
        await server.close();
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    await server.connect(new StdioServerTransport());
    console.error(`Rigour MCP gateway running in ${config.mode} mode for ${Object.keys(config.servers).length} downstream server(s)`);
}
