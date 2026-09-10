# ADR 003: Adaptive execution graph as the Studio product model

## Status

Accepted

## Context

Rigour is evolving beyond repository scanning toward an adaptive execution kernel for software agents. KeyHive and model or tool gateways will be integrated in later deliveries. Studio must not require another information-architecture redesign when those execution capabilities arrive.

## Decision

Studio uses one stable execution story:

`intent → identity → context → authority → route → action → verification → outcome → learning`

The Engineering Outcome Graph is the primary product view. It is not limited to a code dependency graph. Its ontology supports these durable categories:

- **Actor:** agent, human, team, and owning SME.
- **Intent:** task, request, goal, and risk classification.
- **Scope:** organization, repository, component, file, tool, and capability.
- **Decision:** Rigour policy, human arbitration, host sandbox restriction, provider decision, or evidence-backed advice issued to an agent, each with explicit provenance.
- **Execution:** agent run, code change, command, MCP call, model route, gateway, provider, and opaque credential reference.
- **Proof:** test, deterministic gate, review, attestation, or accepted change.
- **Knowledge:** structural pattern, retained memory, candidate lesson, validated lesson, and promoted team policy.
- **Outcome:** success, failure, rejection, prevented risk, rework, latency, and observed cost.

Only nodes backed by observed data are shown as active. An installed gateway or KeyHive adapter extends the graph through the same schema; absent integrations are described in Settings and are never rendered as live execution.

Advice is a first-class observed node. It links an agent run to the patterns, lessons, and memories that informed the response, and carries an impact receipt with scoped files, cache status, and token estimates. It is evidence of guidance—not proof that the agent followed it or that an outcome was caused by it.

The five primary Studio areas remain stable:

1. **Map** — the complete execution and learning loop.
2. **Agents** — registration, scopes, history, friction, and improvement.
3. **Review** — decisions, firewall, gates, conflicts, and human arbitration.
4. **Knowledge** — lessons, patterns, memory, semantic retrieval, and cost evidence.
5. **Settings** — local, team, gateway, credential, and provider connectivity.

## Boundaries

- Provider health and quota signals may influence routing but cannot change governance policy.
- Model output, agent self-report, vector similarity, and graph proximity are evidence only.
- Credential material is never placed in the graph; only opaque references and access outcomes may appear.
- Host sandbox restrictions are not attributed to the Rigour firewall.
- The local runtime remains the synchronous enforcement boundary. Cloud and self-hosted control planes synchronize asynchronously.
- Source code is not required to leave the workload boundary for fleet, policy, or evidence synchronization.

## Consequences

The interface can grow from today’s local enforcement and learning into KeyHive-backed capacity and gateway routing without changing its core mental model. Product claims remain tied to observed nodes and decision provenance, preventing roadmap concepts from appearing as shipped guarantees.
