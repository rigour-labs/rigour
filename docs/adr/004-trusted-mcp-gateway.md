# ADR 004: Trusted MCP Gateway Foundation

**Status:** Accepted

**Date:** 2026-09-14

**Deciders:** Rigour engineering

## Context

Rigour already had an in-process capability broker and an MCP gateway abstraction, but it did not launch or forward to downstream MCP servers. Capability and arbitration state inside an agent-writable repository also could not be treated as an independent enforcement boundary.

The product needs an adoption path that is useful before hard enforcement, preserves existing local workflows, and does not claim interception outside routes Rigour actually owns.

## Decision

Version 6.2 introduces a focused MCP stdio mediation path:

1. A gateway configuration selects downstream servers and tool allowlists.
2. Trusted configuration, capabilities, receipt keys, and canonical receipts live in a repository-specific directory under `~/.rigour/control`.
3. Repository identity is derived from the canonical path, not its basename.
4. Downstream tools are namespaced as `<server>__<tool>` and represented as Action IR v1 before authorization.
5. `observe` mode forwards allowed tools and records the decision that enforcement would have made.
6. `enforce` mode requires a matching short-lived, one-use capability.
7. Delegation binds issuer and subject and cannot expand action, resource, or expiry.
8. Every denied, forwarded, or failed call produces a chained HMAC-signed receipt.
9. Studio may read the workspace receipt projection, but policy never trusts it.

The existing broker defaults to legacy capability issuance for compatibility. Callers must explicitly select `observe` or `enforce` to receive the new semantics.

## Consequences

- Teams can measure policy impact before enabling enforcement.
- An agent that can edit repository files cannot rewrite the canonical gateway configuration or receipt history through that repository access alone.
- The user or administrator remains responsible for protecting the operating-system account and agent-host configuration.
- Directly configured downstream MCP servers are bypass routes. They must be removed or host-controlled for the mediated path to be meaningful.
- This release does not claim universal shell, browser, network, or cloud interception. Those channels require separate adapters and deployment controls.

## Follow-ups

- Add host-specific setup diagnostics that detect direct parallel MCP routes where host APIs permit it.
- Add shell Action IR and a resident service only after the process boundary and operating-system permissions are defined.
- Surface receipt-chain health, simulated denials, and capability lineage directly in the Studio evidence map.
