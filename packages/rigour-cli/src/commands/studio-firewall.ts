import {
    listExecutionReceipts,
    listTrustedGrants,
    loadGatewayConfig,
    verifyExecutionReceiptChain,
    type CapabilityGrant,
    type ExecutionReceipt,
    type GatewayControlConfig,
} from '@rigour-labs/core';

export interface StudioGatewayEvidence {
    config: GatewayControlConfig | null;
    receipts: ExecutionReceipt[];
    capabilities: CapabilityGrant[];
    chain: { valid: boolean; count: number; reason?: string };
    configurationError?: string;
}

export async function loadStudioGatewayEvidence(cwd: string, controlRoot?: string): Promise<StudioGatewayEvidence> {
    let configurationError: string | undefined;
    const [config, receipts, capabilities, chain] = await Promise.all([
        loadGatewayConfig(cwd, controlRoot).catch((error: unknown) => {
            configurationError = error instanceof Error ? error.message : String(error);
            return null;
        }),
        listExecutionReceipts(cwd, 100, controlRoot).catch(() => []),
        listTrustedGrants(cwd, 100, controlRoot).catch(() => []),
        verifyExecutionReceiptChain(cwd, controlRoot).catch((error: unknown) => ({
            valid: false,
            count: 0,
            reason: error instanceof Error ? error.message : String(error),
        })),
    ]);
    return { config, receipts, capabilities, chain, configurationError };
}

export function summarizeGatewayEvidence(evidence: StudioGatewayEvidence) {
    const { config, receipts, capabilities, chain, configurationError } = evidence;
    if (!config) return { configured: false, configurationError, chain, receipts: [], capabilities: [] };
    return {
        configured: true,
        mode: config.mode,
        agentId: config.agentId,
        taskId: config.taskId,
        servers: Object.entries(config.servers).map(([name, server]) => ({ name, allowedTools: server.allow.length })),
        toolCount: Object.values(config.servers).reduce((total, server) => total + server.allow.length, 0),
        chain,
        receipts: receipts.slice(-30).reverse().map((receipt) => ({
            id: receipt.id,
            operation: receipt.action.operation,
            resource: receipt.action.resource,
            actorId: receipt.action.actorId,
            taskId: receipt.action.taskId,
            mode: receipt.mode,
            decision: receipt.decision,
            simulatedDecision: receipt.simulatedDecision,
            outcome: receipt.outcome,
            reason: receipt.reason,
            capabilityId: receipt.capabilityId,
            createdAt: receipt.createdAt,
        })),
        capabilities: capabilities.map((grant) => ({
            id: grant.id,
            action: grant.action,
            resource: grant.resource,
            issuerId: grant.issuerId,
            subjectId: grant.subjectId ?? grant.agentId,
            taskId: grant.taskId,
            parentCapabilityId: grant.parentCapabilityId,
            expiresAt: grant.expiresAt,
            used: grant.used,
        })),
    };
}

export function getGatewayMediationState(gateway: ReturnType<typeof summarizeGatewayEvidence>): 'not_configured' | 'configured' | 'observed' {
    if (!gateway.configured) return 'not_configured';
    return gateway.receipts.length > 0 ? 'observed' : 'configured';
}
