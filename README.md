# Rigour

[![npm version](https://img.shields.io/npm/v/@rigour-labs/cli?color=cyan&label=cli)](https://www.npmjs.com/package/@rigour-labs/cli)
[![cli downloads](https://img.shields.io/npm/dm/@rigour-labs/cli?color=blue&label=cli+downloads)](https://www.npmjs.com/package/@rigour-labs/cli)
[![mcp downloads](https://img.shields.io/npm/dm/@rigour-labs/mcp?color=blue&label=mcp+downloads)](https://www.npmjs.com/package/@rigour-labs/mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![MCP Registry](https://img.shields.io/badge/MCP-Listed-green)](https://rigour.run)
[![OWASP](https://img.shields.io/badge/OWASP-Project-red)](https://rigour.run)

**Your AI agent just tried to commit an AWS secret. Rigour blocked it in <100ms.**

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
{ "mcpServers": { "rigour": { "command": "npx", "args": ["-y", "@rigour-labs/mcp"] } } }
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

No extra commands. The dashboard appears when the agent calls Rigour tools. Watch your agent self-heal in real time.

## What it catches

| Category | Gates |
|---|---|
| **Security** | Hardcoded secrets (29+ patterns), SQL injection, XSS, CSRF, prototype pollution, Shannon entropy |
| **Structural** | File size, cyclomatic complexity, method count, parameter count, nesting depth, TODO/FIXME |
| **AI Drift** | Hallucinated imports, phantom APIs, context drift, retry loop detection |
| **Governance** | Agent team isolation, checkpoint supervision, memory DLP |

AST-based. Not heuristics. **TypeScript, JavaScript, Python, Go, Ruby, C#, Java, Kotlin, Rust.**

## How it works

```
Agent writes code → Rigour gates fire → FAIL? → Fix Packet (JSON)
                                           ↓
                                    Agent reads exact instructions
                                           ↓
                                    Agent fixes → PASS ✓
```

No human in the loop. The agent gets told exactly what's wrong, on which line, and how to fix it — in JSON it can consume.

## The Brain — learns your codebase

Every scan reinforces patterns. Patterns decay when absent. At `strength: 0.9`, they promote to hard rules. Your project's own immune system — trained locally, zero telemetry.

```
First week:  catches 12 violations
First month: catches 8 violations  ← learning your patterns
Third month: catches 3 violations  ← your agents have adapted
```

## How it's different

| | Rigour | ESLint | Cloud tools |
|---|---|---|---|
| Runs locally, zero telemetry | ✅ | ✅ | ❌ |
| Learns YOUR codebase (Brain) | ✅ | ❌ | ❌ |
| Agent self-healing (Fix Packets) | ✅ | ❌ | ❌ |
| Works offline (GGUF sidecar) | ✅ | ✅ | ❌ |
| AI-native drift detection | ✅ | ❌ | ❌ |
| MCP-native (26 tools) | ✅ | ❌ | ❌ |

## Used in production

- **19,000+ total installs** across CLI and MCP
- **Organically forked by Alibaba iFlow**
- **OWASP project** — listed
- **Cursor MCP directory** — listed
- **Zero false positives** on 202-finding production audit

## Quick reference

```bash
npx rigour-scan                              # zero-config scan
npx @rigour-labs/cli init                    # add gates to your project
npx @rigour-labs/cli check                   # run gates
npx @rigour-labs/cli check --deep            # + local AI analysis
npx @rigour-labs/cli check --deep --provider claude -k sk-ant-xxx  # cloud AI
npx @rigour-labs/cli studio                  # monitoring dashboard
```

## Architecture

| Package | Purpose |
|---|---|
| `@rigour-labs/core` | Gate engine, AST analysis, Fix Packets, Brain |
| `@rigour-labs/cli` | `init`, `check`, `scan`, `run`, `studio` |
| `@rigour-labs/mcp` | MCP server — 26 tools for agent integration |
| `rigour-scan` | Zero-config shortcut: `npx rigour-scan` |

**Stack:** TypeScript strict, web-tree-sitter, Zod, Vitest.

---

**[Full docs](https://docs.rigour.run)** | **[Technical Spec](docs/SPEC.md)** | **[Philosophy](docs/PHILOSOPHY.md)**

MIT © [Rigour Labs](https://github.com/rigour-labs) — Built by [Ashutosh](https://github.com/erashu212)

*If Rigour caught something real in your codebase — [tell us](https://github.com/rigour-labs/rigour/discussions).*
