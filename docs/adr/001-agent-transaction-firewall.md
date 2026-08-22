# ADR 001: Agent Transaction Firewall

**Status:** Accepted  
**Date:** 2026-08-12  
**Deciders:** Rigour engineering

## Context

Rigour historically observed agent behaviour (hooks, gates, Fix Packets, voluntary `rigour_check`). That is not a hard security boundary: arbitration failed open, `shell: true` allowed arbitrary commands, agent scopes were advisory, and MCP tools were peer governance tools—not a capability gateway.

Competitors in ASPM/red-team space focus on attack simulations and semantic runtime judges. Rigour’s durable category is different: treat the agent as an untrusted proposer and own deterministic execution.

## Decision

Introduce an **Agent Transaction Firewall** kernel in `@rigour-labs/core` (`src/firewall/`):

1. **Capability broker** — one-use, short-lived capabilities; tool allowlists; secret leasing without exposing credentials to agents.
2. **Typed command runner** — argv allowlist; no agent-facing `shell: true`.
3. **Scope enforcement** — registered agent globs bind mediated writes (hooks + broker).
4. **Fail-closed arbitration** — timeout denies execution.
5. **Transactions** — worktree START → verify → COMMIT | DISCARD.
6. **Attestation** — HMAC-signed bundles; CI admission requires valid PASS attestation.
7. **Adversarial replay** — deterministic corpus; unexpected allows emit policy regression fixtures (no LLM judge on the hot path).

Studio visualizes kernel decisions (allow/deny/timeout-deny, capabilities, transactions, attestation). Deep Analysis remains explanatory only.

## Consequences

- Agents cannot be trusted to invoke their own guardrails; mediation must be installed (hooks/gateway/CLI).
- Hosts that ignore hook exit codes are out-of-warranty; Studio should surface mediation health.
- Adversarial testing is complementary CI proof, not the product.

## Interfaces (gateway sketch)

```ts
interface McpGateway {
  listTools(agentId: string, taskId: string): Promise<ToolDescriptor[]>; // filtered
  invoke(req: {
    agentId: string;
    taskId: string;
    tool: string;
    args: Record<string, unknown>;
    capabilityId?: string;
  }): Promise<{ decision: 'allow' | 'deny'; result?: unknown; reason: string }>;
  leaseSecret(name: string, purpose: string): Promise<{ capabilityId: string }>; // never returns secret material to agent
}
```

Full MCP proxy packaging may live in `packages/rigour-gateway` in a follow-up; core types and broker land first.
