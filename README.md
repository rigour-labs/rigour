# Rigour

[![npm version](https://img.shields.io/npm/v/@rigour-labs/cli?color=cyan&label=cli)](https://www.npmjs.com/package/@rigour-labs/cli)
[![cli downloads](https://img.shields.io/npm/dm/@rigour-labs/cli?color=blue&label=cli+downloads)](https://www.npmjs.com/package/@rigour-labs/cli)
[![mcp downloads](https://img.shields.io/npm/dm/@rigour-labs/mcp?color=blue&label=mcp+downloads)](https://www.npmjs.com/package/@rigour-labs/mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![MCP Registry](https://img.shields.io/badge/MCP-Listed-green)](https://rigour.run)
[![OWASP](https://img.shields.io/badge/OWASP-Project-red)](https://rigour.run)

**Your AI agent just tried to commit an AWS secret. Rigour blocked it in <100ms.**

**Agent Transaction Firewall (v6):** treat the agent as an untrusted proposer. Rigour decides—deterministically—what it may write, run, call, and ship. No AI judge on the allow/deny path.

## Try it now (zero config)

```bash
npx rigour-scan
```

Works on any repo. No init, no config, no setup. Instant results in your terminal:

```
  HARDCODED SECRET DETECTED
  AWS_SECRET_ACCESS_KEY found in src/config.ts:23

  + 22 more violations across 847 files (2.1s)

  Score        ████░░░░░░░░░░░░░░░░  34/100
  AI Health    ███░░░░░░░░░░░░░░░░░░  28/100

  Gates:  ✅ file-size  ❌ security  ❌ ast  ✅ deps

  Brain: learned 12 patterns · trend: improving ↑
```

## Add to your AI IDE (30 seconds)

```json
{ "mcpServers": { "rigour": { "command": "npx", "args": ["-y", "@rigour-labs/mcp@latest"] } } }
```

| IDE / Agent | MCP Tools | Live Dashboard | Real-Time Feed |
|---|---|---|---|
| **Claude Desktop** | ✅ | ✅ MCP App | ✅ Logging |
| **VS Code Copilot** | ✅ | ✅ MCP App | ✅ Logging |
| **ChatGPT** | ✅ | ✅ MCP App | ✅ Logging |
| **Goose** | ✅ | ✅ MCP App | ✅ Logging |
| **Claude Code** | ✅ | — | ✅ Logging |
| **Cursor** | ✅ | — | ✅ Logging |
| **Cline** | ✅ | — | ✅ Logging |
| **Windsurf** | ✅ | — | ✅ Logging |
| **Codex** | ✅ | — | ✅ Logging |

Then install hooks so writes are checked in real time:

```bash
npx @rigour-labs/cli hooks init --tool cursor   # or claude, cline, windsurf
# or via MCP: rigour_hooks_init
```

## Does the firewall run automatically?

**Short answer:** quality gates + DLP + mediated `rigour_run` paths run when MCP/hooks are installed. It does **not** yet sit in front of every third-party MCP tool (GitHub/Slack/etc.)—that gateway is designed but not the default proxy.

| Surface | Automatic once installed? | What you get |
|---|---|---|
| **MCP server** (`@rigour-labs/mcp`) | Yes for Rigour tools the agent calls | `rigour_check`, Fix Packets, memory DLP, agent register, Studio events |
| **`rigour_run` / `rigour_run_supervised`** | Yes when those tools are used | Typed argv allowlist (no free-form `shell: true`), fail-closed human arbitration (timeout = deny), one-time Studio token |
| **IDE hooks** (Cursor/Claude/Cline/Windsurf) | Yes after `hooks init` | Per-write checks (secrets, imports, size, protected paths). If agents are registered, set `RIGOUR_AGENT_ID` so scope binds to the writer (fail-closed; no union-allow) |
| **`rigour_agent_register`** | Yes when called | Rejects `**/*` / sensitive globs unless operator scopes or `RIGOUR_ALLOW_AGENT_SCOPE_AUTHORITY=1` |
| **CLI firewall** | On demand / CI | `firewall adversarial`, `firewall transact`, `firewall admit` |
| **Third-party MCP proxy** | Not yet | Capability broker + `McpGateway` interfaces exist; Rigour is not yet a MITM for all MCP servers |

```
Agent proposes action
        ↓
Hooks / MCP mediation (when on the path)
        ↓
Deterministic deny/allow + rule id
        ↓
Studio evidence  ·  CI attestation (admit)
```

## Agent Transaction Firewall

```bash
npx @rigour-labs/cli firewall status
npx @rigour-labs/cli firewall adversarial   # deterministic corpus — unexpected allows fail CI
npx @rigour-labs/cli firewall transact --agent <id> --scope 'packages/foo/**'
npx @rigour-labs/cli firewall admit         # CI: valid attestation + PASS + bound git tree
npx @rigour-labs/cli studio                 # Firewall tab: decisions, attestation, mediation health
```

**Guarantees (on mediated paths):** fail-closed arbitration · typed commands · per-agent scope · signed attestation bound to commit/tree · adversarial replay as regression fuel—not an AI red-team product.

See [ADR 001](docs/adr/001-agent-transaction-firewall.md).

## Live governance dashboard (MCP App)

In supported editors, a real-time dashboard appears automatically as your agent works:

```
┌─ Rigour Governance ──────────────────────────┐
│  Score: 94/100  ✅ PASS                      │
│                                               │
│  14:32:01  rigour_check → FAIL (34/100)       │
│  14:32:03  fix_packet → 8 fixes               │
│  14:32:15  rigour_check → 71/100 (+37)        │
│  14:32:22  rigour_check → ✅ PASS 94/100      │
│                                               │
│  Brain: 47 patterns · trend: improving ↑      │
└───────────────────────────────────────────────┘
```

No extra commands. The dashboard appears when the agent calls Rigour tools. Watch your agent self-heal in real time. Open **Firewall** in Studio for allow/deny decisions and mediation status (`partial` until the MCP gateway is fully wired).

## What it catches

| Category | Gates |
|---|---|
| **Security** | Hardcoded secrets (29+ patterns), SQL injection, XSS, CSRF, prototype pollution, Shannon entropy |
| **Structural** | File size, cyclomatic complexity, method count, parameter count, nesting depth, TODO/FIXME |
| **AI Drift** | Hallucinated imports, phantom APIs, context drift, retry loop detection |
| **Governance** | Agent team isolation, checkpoint supervision, memory DLP |
| **Firewall** | Out-of-scope writes, undeclared MCP tools, disallowed shell, fail-closed timeouts |

AST-based. Not heuristics. **TypeScript, JavaScript, Python, Go, Ruby, C#, Java, Kotlin, Rust.**

## How it works

```
Agent writes code → Hooks / gates fire → FAIL? → Fix Packet (JSON)
                                           ↓
                                    Agent reads exact instructions
                                           ↓
                                    Agent fixes → PASS ✓

Mediated run (rigour_run) → typed allowlist → human arbitration (fail-closed)
                                           ↓
                                    execute or deny + evidence
```

Voluntary `rigour_check` is a **quality workflow**, not the security boundary. Hard guarantees require installed hooks/MCP mediation and (for CI) `firewall admit`.

## The Brain — learns your codebase

Every scan reinforces patterns. Patterns decay when absent. At `strength: 0.9`, they promote to hard rules. Your project's own immune system — trained locally, zero telemetry.

```
First week:  catches 12 violations
First month: catches 8 violations  ← learning your patterns
Third month: catches 3 violations  ← your agents have adapted
```

## How it's different

| | Rigour | ESLint | “AI security agents” |
|---|---|---|---|
| Runs locally, zero telemetry | ✅ | ✅ | often ❌ |
| Learns YOUR codebase (Brain) | ✅ | ❌ | ❌ |
| Agent self-healing (Fix Packets) | ✅ | ❌ | ❌ |
| Deterministic execution firewall | ✅ | ❌ | usually LLM judge |
| Works offline (GGUF sidecar) | ✅ | ✅ | ❌ |
| AI-native drift detection | ✅ | ❌ | ❌ |
| MCP-native | ✅ | ❌ | varies |

## Used in production

- **19,000+ total installs** across CLI and MCP
- **Organically forked by Alibaba iFlow**
- **OWASP project** — listed
- **Cursor MCP directory** — listed

## Quick reference

```bash
npx rigour-scan                              # zero-config scan
npx @rigour-labs/cli init                    # add gates to your project
npx @rigour-labs/cli hooks init --tool cursor
npx @rigour-labs/cli check                   # run gates
npx @rigour-labs/cli check --deep            # + local AI analysis
npx @rigour-labs/cli check --deep --provider claude -k sk-ant-xxx  # cloud AI
npx @rigour-labs/cli studio                  # monitoring + Firewall tab
npx @rigour-labs/cli firewall adversarial
npx @rigour-labs/cli firewall admit
```

## Architecture

| Package | Purpose |
|---|---|
| `@rigour-labs/core` | Gate engine, AST, Fix Packets, Brain, **firewall kernel** |
| `@rigour-labs/cli` | `init`, `check`, `scan`, `run`, `studio`, `firewall` |
| `@rigour-labs/mcp` | MCP server — governance tools for agent integration |
| `rigour-scan` | Zero-config shortcut: `npx rigour-scan` |

**Stack:** TypeScript strict, web-tree-sitter, Zod, Vitest.

---

**[Full docs](https://docs.rigour.run)** | **[Technical Spec](docs/SPEC.md)** | **[Philosophy](docs/PHILOSOPHY.md)** | **[Firewall ADR](docs/adr/001-agent-transaction-firewall.md)**

MIT © [Rigour Labs](https://github.com/rigour-labs) — Built by [Ashutosh](https://github.com/erashu212)

*If Rigour caught something real in your codebase — [tell us](https://github.com/rigour-labs/rigour/discussions).*
