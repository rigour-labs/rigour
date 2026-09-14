/**
 * Agent Transaction Firewall — shared types.
 * Deterministic allow/deny decisions; no LLM on the hot path.
 */

export type FirewallDecision = 'allow' | 'deny' | 'timeout-deny' | 'scope-violation';

export type CapabilityAction =
    | 'filesystem.write'
    | 'filesystem.read'
    | 'shell.exec'
    | 'mcp.call'
    | 'git.mutate'
    | 'secret.lease'
    | 'network.egress'
    | 'deploy';

export interface CapabilityGrant {
    id: string;
    action: CapabilityAction;
    resource: string;
    constraints?: Record<string, unknown>;
    expiresAt: number;
    agentId?: string;
    taskId?: string;
    policyHash: string;
    used: boolean;
    issuerId?: string;
    subjectId?: string;
    parentCapabilityId?: string;
}

export interface PolicyEvaluation {
    decision: FirewallDecision;
    reason: string;
    ruleId?: string;
    capabilityId?: string;
    policyHash: string;
    timestamp: string;
    simulatedDecision?: Exclude<FirewallDecision, 'allow'>;
}

export type EnforcementMode = 'observe' | 'enforce';

export interface AgentAction {
    version: 1;
    actorId: string;
    taskId: string;
    channel: 'mcp' | 'shell';
    operation: string;
    resource: string;
    environment: 'local' | 'development' | 'staging' | 'production' | 'unknown';
    sideEffect: 'read' | 'local-write' | 'external-write' | 'destructive';
    reversibility: 'high' | 'medium' | 'low' | 'unknown';
    sensitivity: 'normal' | 'sensitive' | 'restricted';
    blastRadius: 'single-resource' | 'bounded' | 'broad' | 'unknown';
}

export interface ExecutionReceipt {
    version: 1;
    id: string;
    repositoryId: string;
    action: AgentAction;
    mode: EnforcementMode;
    decision: FirewallDecision;
    simulatedDecision?: Exclude<FirewallDecision, 'allow'>;
    reason: string;
    capabilityId?: string;
    policyHash: string;
    outcome: 'forwarded' | 'denied' | 'failed';
    createdAt: string;
    previousReceipt?: string;
    digest: string;
    signature: string;
}

export interface TypedCommand {
    bin: string;
    args: string[];
    cwd?: string;
}

export interface TransactionBudgets {
    maxFiles: number;
    maxRetries: number;
    maxDurationMs: number;
    maxCostUsd?: number;
}

export type TransactionStatus =
    | 'START'
    | 'RUNNING'
    | 'VERIFYING'
    | 'COMMIT'
    | 'DISCARD';

export interface TransactionRecord {
    id: string;
    agentId?: string;
    scope: string[];
    status: TransactionStatus;
    worktreePath?: string;
    budgets: TransactionBudgets;
    filesChanged: string[];
    capabilitiesIssued: string[];
    decisions: PolicyEvaluation[];
    startedAt: string;
    finishedAt?: string;
    policyHash: string;
}

export interface AttestationBundle {
    version: 1;
    transactionId: string;
    agentId?: string;
    userId?: string;
    scope: string[];
    policyHash: string;
    capabilities: string[];
    filesUsed: string[];
    toolsUsed: string[];
    gateResults: { status: string; score?: number; failedGates: string[] };
    overrides: string[];
    artifactDigest: string;
    /** git commit SHA at attestation time */
    commitSha?: string;
    /** git tree object id (HEAD^{tree}) */
    treeDigest?: string;
    signedAt: string;
    signature: string;
}

export interface AdversarialCase {
    id: string;
    description: string;
    proposedAction: {
        action: CapabilityAction;
        resource: string;
        args?: Record<string, unknown>;
        command?: string;
    };
    expectedDecision: FirewallDecision;
    agentScope?: string[];
    allowlist?: string[];
}

export interface AdversarialCaseResult {
    caseId: string;
    expected: FirewallDecision;
    actual: FirewallDecision;
    passed: boolean;
    reason: string;
    suggestedRule?: string;
}
