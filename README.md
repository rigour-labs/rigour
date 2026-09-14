# Rigour

[![npm version](https://img.shields.io/npm/v/@rigour-labs/cli?color=22d3ee&label=cli)](https://www.npmjs.com/package/@rigour-labs/cli)
[![npm downloads](https://img.shields.io/npm/dm/@rigour-labs/cli?color=2563eb&label=downloads)](https://www.npmjs.com/package/@rigour-labs/cli)
[![License: MIT](https://img.shields.io/badge/license-MIT-facc15.svg)](https://opensource.org/licenses/MIT)
[![MCP Registry](https://img.shields.io/badge/MCP-Listed-22c55e)](https://rigour.run)

**Your coding agents write code. Rigour makes the codebase learn.**

Rigour is a local-first engineering intelligence layer for coding agents. It gives agents the smallest useful context, enforces deterministic boundaries around observable work, and turns verified outcomes into reusable knowledge for the next task.

It is not another chat wrapper or a prettier linter dashboard. Rigour connects **code, agent actions, decisions, proof, and learning** into one evidence-backed system.

```bash
npx rigour-scan
```

[▶ Watch Rigour in action](https://www.mediafire.com/file/ohy86pcne9e8wmx/1789196277897739.mp4/file)

Run this in any repository to see the first signal. No account or hosted service required.

## Why teams use Rigour

| Pain | Rigour’s answer | What you can see |
| --- | --- | --- |
| Agents rediscover the codebase every task | Structural retrieval, patterns, memory, and validated lessons narrow the context | Why files were selected, excluded, reused, or invalidated |
| Agents move quickly without enough proof | Deterministic gates, hooks, DLP, scoped execution, and Fix Packets | The decision, rule, evidence, and resulting repair loop |
| Good work disappears between sessions | Evidence from observable agent work becomes candidate learning, then only promotes after proof | Personal and team knowledge with state, owner, scope, and provenance |

## See how agent work improves the codebase

Rigour Studio is an evidence map for engineering work—not just a dependency graph.

```text
intent → context → policy → agent action → verification → outcome → learning
                    │                         │               │
                    └──── advice + impact ────┴───────────────┘
```

Open Studio to trace an agent run from the recommendation it received to the code it changed, the checks that ran, the risk it prevented, and the knowledge it left behind.

```bash
npx @rigour-labs/cli init
npx @rigour-labs/cli hooks init
npx @rigour-labs/cli studio
```

The five product areas stay simple:

- **Map** — connect code structure, agent activity, decisions, proof, and outcomes.
- **Agents** — inspect scopes, run history, handoffs, and the guidance each agent received.
- **Review** — understand gates, policy decisions, conflicts, and Fix Packets.
- **Knowledge** — explore patterns, memory, lessons, semantic recall, drift, and cost evidence.
- **Settings** — see index, graph, cache, learning, storage, and connectivity health.

## Start in three minutes

### 1. Scan a repository

```bash
npx rigour-scan
```

Rigour runs local quality, security, and AI-drift checks and returns an actionable result.

### 2. Add the Rigour loop

```bash
npx @rigour-labs/cli init
npx @rigour-labs/cli hooks init --tool cursor
npx @rigour-labs/cli skills install --target codex,cursor
npx @rigour-labs/cli check
```

`hooks init` supports Cursor, Claude Code, Cline, and Windsurf. It checks observable writes as agents work; `check` is the full project verification step.

### 3. Give every agent the same good workflow

```bash
rigour skills install --target codex,cursor
```

Rigour Skills turn its evidence loop into small, reusable agent workflows:

- `rigour-context` asks for the smallest explainable scope before an agent reads code.
- `rigour-verify` closes a change with proof and a Fix Packet repair loop.
- `rigour-handoff` transfers verified state without replaying an entire session.

Codex receives native repository skills in `.agents/skills`. Cursor receives focused slash commands in `.cursor/commands`. Portable copies land in `docs/rigour-skills` for other MCP-capable agents. Existing files are preserved unless `--force` is explicitly used.

### 4. Give your agent Rigour through MCP

```json
{
  "mcpServers": {
    "rigour": {
      "command": "npx",
      "args": ["-y", "@rigour-labs/mcp@latest"]
    }
  }
}
```

Agents can ask Rigour for scoped context, register their work, receive Fix Packets, record checkpoints and handoffs, and leave evidence for Studio.

### 5. Mediate high-impact MCP tools (6.2)

Rigour can sit in front of selected MCP servers, expose only approved tools, normalize every call into a common action record, and issue a signed execution receipt. Start in `observe` mode to see what policy would block without interrupting work; switch to `enforce` only after reviewing the evidence.

```bash
rigour firewall gateway-configure --config ~/rigour-gateway.json
rigour firewall status
rigour firewall grant --agent coding-agent --task TASK-123 \
  --tool github__create_issue --ttl 300
rigour firewall receipts
```

Trusted state and canonical receipts live outside the repository; Studio receives a projection for explanation, never as an enforcement input. Follow [MCP Integration](docs/MCP_INTEGRATION.md) for the configuration and exact security boundary.

## What Rigour does differently

### Context that can explain itself

Rigour builds a structural index immediately and enriches semantic retrieval in the background. When an agent asks for help, it returns the smallest evidence-backed scope it can justify—not a repository dump. Each recommendation records its sources, exclusions, cache reuse, and estimated context savings.

### Learning with a proof boundary

Rigour records evidence from its hooks, MCP calls, context retrieval, Fix Packets, accepted changes, checkpoints, handoffs, tests, and human feedback. A lesson starts as a `candidate`. It becomes reusable only after deterministic verification, repeated successful outcomes, or explicit confirmation.

Model text, vector similarity, rejected fixes, and failed tests can inform investigation. They do not become enforcement rules on their own.

### Governance agents can work with

Rigour’s deterministic checks catch security issues, structural regressions, hallucinated imports, phantom APIs, context drift, and more. On supported mediated paths, the Agent Transaction Firewall applies per-agent scopes, typed command allowlists, fail-closed arbitration, and signed attestations.

When work fails a check, Rigour gives the agent a **Fix Packet**: the rule, affected files, evidence, and concrete next action.

## Local first. Team-ready when you are.

Rigour works fully in local-only mode with SQLite. Nothing requires an account.

For teams, PostgreSQL becomes the durable source for private-user and approved shared knowledge; encrypted SQLite remains the local cache and offline outbox. If pgvector is enabled, Rigour can use semantic recall as advisory input while repository scope and lesson state continue to control what applies.

```bash
rigour team init-schema --database-url 'postgresql://…' --pgvector
rigour team configure --database-url 'postgresql://…' \
  --organization acme --team platform --actor ashutosh --pgvector
rigour team doctor
```

When team storage is unavailable, local enforcement and evidence capture continue. Studio reports the state as **offline — changes queued**.

## Guarantees and boundaries

Rigour is deliberately precise about what it does and does not claim.

- Core checks and storage are local-first; cloud deep analysis is opt-in.
- Rigour can enforce work that passes through its installed hooks or MCP gateway. A directly configured parallel MCP server bypasses that gateway unless the host or administrator removes that route.
- Advice is evidence of what Rigour recommended, not proof that an agent followed it or that it caused an outcome.
- Observed spend, measured estimates, and modelled savings are shown separately so cost numbers do not over-promise.

Read the architectural decisions behind these boundaries: [Agent Transaction Firewall](docs/adr/001-agent-transaction-firewall.md), [Evidence Learning & Team Storage](docs/adr/002-evidence-learning-team-storage.md), [Adaptive Execution Graph](docs/adr/003-adaptive-execution-graph.md), and [Trusted MCP Gateway](docs/adr/004-trusted-mcp-gateway.md).

## Documentation

| If you want to… | Start here |
| --- | --- |
| Install and run Rigour | [Quick Start](docs/QUICK_START.md) |
| Connect a coding agent | [Agent Integration](docs/AGENT_INTEGRATION.md) · [MCP Integration](docs/MCP_INTEGRATION.md) |
| Understand a failed check | [Fix Packets](docs/FIX_PACKET.md) · [AST Gates](docs/AST_GATES.md) |
| Configure policies and deep analysis | [Configuration](docs/CONFIGURATION.md) · [Deep Analysis](docs/DEEP_ANALYSIS.md) |
| Set up PostgreSQL, pgvector, and team knowledge | [Enterprise & Teams](docs/ENTERPRISE.md) |
| Review the product philosophy | [Philosophy](docs/PHILOSOPHY.md) |

## Build from source

```bash
pnpm install
pnpm build
pnpm test
node packages/rigour-cli/dist/cli.js studio
```

If a fresh clone reports ignored native build scripts, review and approve the required builds with `pnpm approve-builds`, then rerun the commands.

---

**[Documentation](https://docs.rigour.run)** · **[Discussions](https://github.com/rigour-labs/rigour/discussions)** · **[Issues](https://github.com/rigour-labs/rigour/issues)**

MIT © [Rigour Labs](https://github.com/rigour-labs) · Built by [Ashutosh](https://github.com/erashu212)
