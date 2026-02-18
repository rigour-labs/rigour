# Rigour

[![npm version](https://img.shields.io/npm/v/@rigour-labs/cli?color=cyan&label=cli)](https://www.npmjs.com/package/@rigour-labs/cli)
[![npm downloads](https://img.shields.io/npm/dm/@rigour-labs/cli?color=blue)](https://www.npmjs.com/package/@rigour-labs/cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.18673564.svg)](https://doi.org/10.5281/zenodo.18673564)
[![OWASP Coverage](https://img.shields.io/badge/OWASP_LLM_Top_10-10%2F10_covered-green)](./docs/OWASP_MAPPING.md)

**Deterministic quality gates that force AI agents to write production-grade code.**

Rigour sits between your AI agent and the codebase — catching hallucinated imports, hardcoded secrets, and floating promises **the instant they're written**, not after CI fails.

> Zero cloud. Zero telemetry. Fully local. MIT licensed.

---

## See It In Action

![Rigour Demo](https://raw.githubusercontent.com/rigour-labs/rigour/main/docs/assets/demo.gif)

Watch an AI agent write flawed code, Rigour hooks catch each issue **in real time**, then the agent self-corrects — score jumps from **35 → 91**.

```bash
npx @rigour-labs/cli demo --cinematic
```

---

## Quick Start

```bash
npx @rigour-labs/cli init          # Auto-detect project, generate config
npx @rigour-labs/cli check         # Run 23 quality gates → PASS or FAIL
npx @rigour-labs/cli hooks init    # Wire into Claude/Cursor/Cline/Windsurf
```

---

## The Problem

Every team using AI code generation hits the same wall:

```
Agent writes code → Claims "Done!" → Hardcoded secrets, hallucinated packages, floating promises
→ CI fails 10 minutes later → Human intervenes → Repeat
```

This is **"Vibe Coding"** — the agent optimizes for appearing correct, not for being safe. The OWASP Foundation now tracks this as a [Top 10 risk for LLM-generated code](./docs/OWASP_MAPPING.md).

## How Rigour Solves It

**Two layers of enforcement:**

**Layer 1 — Real-time hooks** (<200ms per file): As the AI agent writes each file, Rigour's hooks run 4 fast gates (hallucinated imports, promise safety, security patterns, file size) and flag issues instantly — before the agent moves to the next file.

**Layer 2 — Full quality gates** (23 gates): On `rigour check`, the complete gate suite runs: AST complexity, duplication drift, context window artifacts, inconsistent error handling, and more. Produces structured **Fix Packets** (JSON) that agents consume directly — no human interpretation needed.

```
Agent writes code → Hook catches issue → Agent retries → Hook passes → Full check → PASS ✓
```

---

## OWASP LLM Top 10 Coverage

Rigour has **Strong coverage on all 10 risks** from the [OWASP Top 10 for LLM-Generated Code (2025)](./docs/OWASP_MAPPING.md):

| OWASP Risk | Rigour Gate | Coverage |
|:---|:---|:---|
| Injection Flaws | `security-patterns` (SQL, XSS, command, eval) | **Strong** |
| Insecure Auth (hardcoded creds) | `security-patterns` | **Strong** |
| Sensitive Data Exposure | `security-patterns` | **Strong** |
| Hallucinated Dependencies | `hallucinated-imports` | **Strong** |
| Improper Error Handling | `promise-safety`, `inconsistent-error-handling` | **Strong** |
| Insecure Output Handling | `security-patterns` (reflection, template injection) | **Strong** |
| DoS Vulnerabilities | `security-patterns` (ReDoS), `ast` (complexity) | **Strong** |
| Insufficient Input Validation | `security-patterns` (raw parse, `as any`), `ast` | **Strong** |
| Overly Permissive Code | `security-patterns` (CORS `*`, `0.0.0.0`, chmod 777) | **Strong** |
| Inadequate Code Quality | `duplication-drift`, `file-size`, `content-check`, `ast` | **Strong** |

[Full mapping with details →](./docs/OWASP_MAPPING.md)

---

## Real-Time Hooks

One command wires Rigour into your AI coding tool:

```bash
npx @rigour-labs/cli hooks init              # Auto-detects installed tools
npx @rigour-labs/cli hooks init --tool all   # Claude + Cursor + Cline + Windsurf
```

| Tool | Hook Type | What Happens |
|:---|:---|:---|
| **Claude Code** | `PostToolUse` on Write/Edit | Rigour checks every file the agent writes |
| **Cursor** | `afterFileEdit` | Stdin-based checker runs on each edit |
| **Cline** | `PostToolUse` executable | Injects fix context back into the agent |
| **Windsurf** | `post_write_code` | Cascade agent gets instant feedback |

Hooks run **4 fast gates in <200ms**: `hallucinated-imports`, `promise-safety`, `security-patterns`, `file-size`.

---

## What Gets Checked

**23 quality gates** across five categories:

### Security Gates
| Gate | What It Catches | Severity |
|:---|:---|:---|
| **Hardcoded Secrets** | API keys (`sk-`, `ghp_`, `AKIA`), passwords, tokens | `critical` |
| **SQL Injection** | Unsanitized query construction | `critical` |
| **Command Injection** | Shell execution with user input | `critical` |
| **XSS Patterns** | Dangerous DOM manipulation | `high` |
| **Path Traversal** | File operations with unsanitized paths | `high` |

### AI Drift Detection
| Gate | What It Catches | Severity |
|:---|:---|:---|
| **Hallucinated Imports** | Imports referencing packages that don't exist (JS/TS, Python, Go, Ruby, C#) | `critical` |
| **Duplication Drift** | Near-identical functions — AI re-invents what it forgot it already wrote | `high` |
| **Context Window Artifacts** | Clean code at top, degraded code at bottom — context overflow signature | `high` |
| **Inconsistent Error Handling** | Same error type handled 4 different ways across sessions | `high` |
| **Async & Error Safety** | Floating promises, unhandled errors across 6 languages | `high` |

### Structural Gates
| Gate | What It Enforces | Severity |
|:---|:---|:---|
| **Cyclomatic Complexity** | Max 10 per function (configurable) | `medium` |
| **File Size** | Max lines per file (default 300–500) | `low` |
| **Method/Param/Nesting** | Max 12 methods, 5 params, 4 nesting levels | `medium` |
| **Content Hygiene** | Zero tolerance for TODO/FIXME left by agents | `info` |

### Agent Governance
| Gate | Purpose | Severity |
|:---|:---|:---|
| **Agent Team** | Multi-agent scope isolation and conflict detection | `high` |
| **Checkpoint** | Long-running execution supervision | `medium` |
| **Retry Loop Breaker** | Detects and stops infinite agent loops | `high` |

Supports **TypeScript, JavaScript, Python, Go, Ruby, and C#/.NET** via `web-tree-sitter`.

---

## Scoring

Every failure carries a **provenance tag** (`ai-drift`, `traditional`, `security`, `governance`) and contributes to two sub-scores:

```
  Overall     ██████████████████░░░░░░░░░░░░ 62/100
  AI Health   █████████████████████░░░░░░░░░ 70/100
  Structural  ███████████████░░░░░░░░░░░░░░░ 51/100
```

| Severity | Deduction | What It Means |
|:---|:---|:---|
| `critical` | −20 pts | Security vulnerabilities, hallucinated code |
| `high` | −10 pts | AI drift patterns, architectural violations |
| `medium` | −5 pts | Complexity violations, structural issues |
| `low` | −2 pts | File size limits |
| `info` | 0 pts | TODOs — tracked but free |

---

## Integration

### MCP Server (Claude Desktop, Cursor, Cline, VS Code)

```json
{
  "mcpServers": {
    "rigour": {
      "command": "npx",
      "args": ["-y", "@rigour-labs/mcp"]
    }
  }
}
```

Exposes `rigour_check`, `rigour_explain`, `rigour_get_fix_packet`, `rigour_review`, and more — giving any MCP-compatible agent direct access to quality gates.

### CI/CD (GitHub Actions)

```yaml
- run: npx @rigour-labs/cli check --ci
```

### Supervisor Mode

```bash
npx @rigour-labs/cli run -- claude "Refactor auth module"
```

Runs the agent, checks gates, feeds back Fix Packets, and retries automatically.

---

## Fix Packet Schema (v2)

Structured, machine-readable diagnostics that agents consume without human interpretation:

```json
{
  "violations": [{
    "id": "ast-complexity",
    "severity": "high",
    "file": "src/auth.ts",
    "line": 45,
    "metrics": { "current": 15, "max": 10 },
    "instructions": [
      "Extract nested conditional logic into a separate validateToken() function",
      "Replace switch statement with strategy pattern"
    ]
  }],
  "constraints": {
    "no_new_deps": true,
    "do_not_touch": [".github/**", "docs/**"]
  }
}
```

---

## Configuration

```yaml
# rigour.yml — generated by `rigour init`
version: 1
preset: api          # auto-detected: ui | api | infra | data
paradigm: functional # auto-detected: oop | functional | minimal

gates:
  max_file_lines: 500
  forbid_todos: true
  ast:
    complexity: 10
    max_methods: 12
    max_params: 5
    max_nesting: 4
  security:
    enabled: true
  hallucinated_imports:
    enabled: true
  promise_safety:
    enabled: true
  duplication_drift:
    enabled: true
    similarity_threshold: 0.8

hooks:
  enabled: true
  tools: [claude, cursor]
  fast_gates: [hallucinated-imports, promise-safety, security-patterns, file-size]
  timeout_ms: 5000

commands:
  lint: "npm run lint"
  test: "npm test"

ignore: ["**/node_modules/**", "**/dist/**"]
```

---

## Architecture

A **pnpm monorepo** with four packages:

| Package | Purpose |
|:---|:---|
| `@rigour-labs/core` | Gate engine, AST analysis, hooks checker, Fix Packet generation |
| `@rigour-labs/cli` | Commands: `init`, `check`, `run`, `demo`, `hooks init`, `studio` |
| `@rigour-labs/mcp` | Model Context Protocol server for agent integration |
| `@rigour-labs/studio` | React-based monitoring dashboard |

**Tech stack:** TypeScript (strict mode), web-tree-sitter, Zod, Commander.js, Vitest, GitHub Actions CI (Ubuntu/macOS/Windows).

---

## Demo Modes

```bash
rigour demo                          # Fast: scaffold → check → results
rigour demo --hooks                  # Show real-time hooks catching AI mistakes
rigour demo --cinematic              # Screen-recording mode (GIF-ready)
rigour demo --cinematic --speed slow # Presentation pacing
```

The cinematic demo simulates an AI agent writing flawed code, hooks catching each issue, the agent fixing them, and a before/after score chart — all with typewriter effects and timed pauses. Perfect for recording with `asciinema`, `terminalizer`, or `vhs`.

---

## Documentation

**[Full docs at docs.rigour.run →](https://docs.rigour.run/)**

| Doc | What's Inside |
|:---|:---|
| [Quick Start](./docs/QUICK_START.md) | Install and run in 60 seconds |
| [Configuration](./docs/CONFIGURATION.md) | Full `rigour.yml` reference |
| [OWASP LLM Mapping](./docs/OWASP_MAPPING.md) | All 10 OWASP LLM code risks covered |
| [AST Gates](./docs/AST_GATES.md) | Cyclomatic complexity, nesting, tree-sitter |
| [Fix Packet Schema](./docs/FIX_PACKET.md) | v2 machine-readable diagnostics |
| [Presets](./docs/PRESETS.md) | `api`, `ui`, `infra`, `data` preset details |
| [MCP Integration](./docs/MCP_INTEGRATION.md) | MCP server setup for Claude/Cursor/Cline |
| [Agent Integration](./docs/AGENT_INTEGRATION.md) | Wiring agents into the feedback loop |
| [Agent Instructions](./docs/AGENT_INSTRUCTIONS.md) | `.mdc` / system prompt patterns |
| [Enterprise CI/CD](./docs/ENTERPRISE.md) | GitHub Actions, team adoption |
| [Regulated Industries](./docs/REGULATED_INDUSTRIES.md) | SOC2, HIPAA, FDA compliance patterns |
| [Fix Packet Spec](./docs/specs/FIX_PACKET_SCHEMA.md) | Formal JSON schema for fix packets |
| [Philosophy](./docs/PHILOSOPHY.md) | Why Rigour exists |

---

## Cite This Project

> Singh, A. (2026). *Deterministic Quality Gates and Governance for AI-Generated Code in Regulated Software Systems.* Rigour Labs. [https://doi.org/10.5281/zenodo.18673564](https://doi.org/10.5281/zenodo.18673564)

```bibtex
@techreport{singh2026rigour,
  title={Deterministic Quality Gates and Governance for AI-Generated Code in Regulated Software Systems},
  author={Singh, Ashutosh},
  year={2026},
  institution={Rigour Labs},
  doi={10.5281/zenodo.18673564},
  url={https://doi.org/10.5281/zenodo.18673564}
}
```

---

## License

MIT © [Rigour Labs](https://github.com/rigour-labs)

Built by [Ashutosh](https://github.com/erashu212) — enforcing the standards that AI agents skip.
