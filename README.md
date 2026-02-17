# Rigour

[![npm version](https://img.shields.io/npm/v/@rigour-labs/cli?color=cyan&label=cli)](https://www.npmjs.com/package/@rigour-labs/cli)
[![npm downloads](https://img.shields.io/npm/dm/@rigour-labs/cli?color=blue)](https://www.npmjs.com/package/@rigour-labs/cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**Deterministic quality gates that force AI agents to write production-grade code.**

AI coding agents (Claude, Cursor, Copilot) routinely claim "done" while leaving behind TODO comments, 1000-line God files, and cyclomatic complexity violations. Rigour sits between the agent and your codebase, enforcing structural standards **before** code ships — not after CI fails.

> Zero cloud. Zero telemetry. Fully local. MIT licensed.

```bash
npx @rigour-labs/cli init        # Auto-detect project, generate config
npx @rigour-labs/cli check       # Run all quality gates → PASS or FAIL
npx @rigour-labs/cli run -- claude "Build feature X"   # Supervised agent loop
```

---

## The Problem

Every team using AI code generation hits the same wall:

```
Agent writes code → Claims "Done!" → Code has TODOs, complexity violations, God files
→ CI fails → Human intervenes → Repeat
```

This is **"Vibe Coding"** — the agent optimizes for appearing correct, not for being maintainable. Tests might pass, but the code violates every structural principle your team spent years establishing.

## How Rigour Solves It

Rigour introduces a **stateless feedback loop** between the agent and the filesystem:

```
Agent writes code → Rigour gates check → FAIL? → Fix Packet (JSON) → Agent retries → PASS ✓
```

The agent never talks to a server. Rigour reads the filesystem, runs deterministic checks, and produces structured **Fix Packets** — machine-readable diagnostics that tell the agent *exactly* what to fix (`"auth.ts line 45: complexity 15, max allowed 10"`).

No opinions. No heuristics. Just PASS or FAIL.

---

## What Gets Checked

Rigour ships with **23 quality gates** across five categories:

### Structural Gates
| Gate | What It Enforces | Severity |
|:---|:---|:---|
| **File Size** | Max lines per file (default 300–500) | `low` |
| **Content Hygiene** | Zero tolerance for TODO/FIXME comments | `info` |
| **Required Docs** | SPEC.md, ARCH.md, DECISIONS.md must exist | `medium` |
| **File Guard** | Protected paths cannot be modified by agents | `medium` |

### AST-Based Code Analysis
| Gate | What It Enforces | Severity |
|:---|:---|:---|
| **Cyclomatic Complexity** | Max 10 per function (configurable) | `medium` |
| **Method Count** | Max 12 methods per class | `medium` |
| **Parameter Count** | Max 5 parameters per function | `medium` |
| **Nesting Depth** | Max 4 levels of nesting | `medium` |

Supports **TypeScript, JavaScript, Python, Go, Ruby, and C#/.NET** via `web-tree-sitter`, with a universal fallback for other languages.

### Security Gates
| Gate | What It Catches | Severity |
|:---|:---|:---|
| **Hardcoded Secrets** | API keys, tokens, passwords in source | `critical` |
| **SQL Injection** | Unsanitized query construction | `critical` |
| **XSS Patterns** | Dangerous DOM manipulation | `high` |
| **Command Injection** | Shell execution with user input | `critical` |
| **Path Traversal** | File operations with unsanitized paths | `high` |

### AI-Native Drift Detection (v2.16+)
| Gate | What It Catches | Severity |
|:---|:---|:---|
| **Duplication Drift** | Near-identical functions across files — AI re-invents what it forgot it already wrote | `high` |
| **Hallucinated Imports** | Imports referencing modules that don't exist in the project (JS/TS, Python, Go, Ruby, C#) | `critical` |
| **Inconsistent Error Handling** | Same error type handled 4 different ways across agent sessions | `high` |
| **Context Window Artifacts** | Quality degradation within a file — clean top, messy bottom | `high` |
| **Async & Error Safety** | Unsafe async/promise patterns, unhandled errors across 6 languages (v2.17+) | `high` |

### Agent Governance (Frontier Model Support)
| Gate | Purpose | Severity |
|:---|:---|:---|
| **Agent Team** | Multi-agent scope isolation and conflict detection | `high` |
| **Checkpoint** | Long-running execution supervision | `medium` |
| **Context Drift** | Prevents architectural divergence over time | `high` |
| **Retry Loop Breaker** | Detects and stops infinite agent loops | `high` |

### Two-Score System & Provenance (v2.17+)

Every failure carries a **provenance tag** (`ai-drift`, `traditional`, `security`, `governance`) and contributes to two sub-scores: **AI Health Score** (AI-specific failures) and **Structural Score** (traditional quality), alongside the overall 0–100 score.

### Severity-Weighted Scoring

Rigour scores your codebase on a 0–100 scale, with deductions weighted by severity:

| Severity | Point Deduction | Meaning |
|:---|:---|:---|
| `critical` | 20 pts | Security vulnerabilities, hallucinated code |
| `high` | 10 pts | AI drift patterns, architectural violations |
| `medium` | 5 pts | Complexity violations, structural issues |
| `low` | 2 pts | File size limits |
| `info` | 0 pts | TODOs, minor hygiene — tracked but free |

This means 5 TODO comments cost 0 points, while a single hardcoded API key costs 20. The score reflects what actually matters.

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

The MCP server exposes `rigour_check`, `rigour_explain`, `rigour_get_fix_packet`, `rigour_review`, and more — giving any MCP-compatible agent direct access to quality gates.

### CI/CD (GitHub Actions)

```yaml
- run: npx @rigour-labs/cli check --ci
```

### Supervisor Mode

```bash
npx @rigour-labs/cli run -- claude "Refactor auth module"
```

Runs the agent, checks gates, feeds back Fix Packets, and retries automatically — up to a configurable max iterations.

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
  forbid_fixme: true
  required_files: [docs/SPEC.md, docs/ARCH.md]
  ast:
    complexity: 10
    max_methods: 12
    max_params: 5
    max_nesting: 4
  security:
    enabled: true
  # AI-Native Drift Detection (all enabled by default)
  duplication_drift:
    enabled: true
    similarity_threshold: 0.8
    min_body_lines: 5
  hallucinated_imports:
    enabled: true
  inconsistent_error_handling:
    enabled: true
    max_strategies_per_type: 2
  context_window_artifacts:
    enabled: true
    min_file_lines: 100
    degradation_threshold: 0.4
  promise_safety:
    enabled: true

commands:
  lint: "npm run lint"
  test: "npm test"

ignore: ["**/node_modules/**", "**/dist/**"]
```

---

## Architecture

Rigour is a **pnpm monorepo** with four packages:

| Package | Purpose | Size |
|:---|:---|:---|
| `@rigour-labs/core` | Gate engine, AST analysis, Fix Packet generation | ~2,400 SLOC |
| `@rigour-labs/cli` | User-facing commands (`init`, `check`, `run`, `studio`) | ~500 SLOC |
| `@rigour-labs/mcp` | Model Context Protocol server for agent integration | ~400 SLOC |
| `@rigour-labs/studio` | React-based monitoring dashboard | Private |

**Tech stack:** TypeScript (strict mode, ESNext), web-tree-sitter, Zod, Vitest, GitHub Actions CI across Ubuntu/macOS/Windows.

---

## Fix Packet Schema (v2)

The core innovation — structured, machine-readable diagnostics that agents can consume without human interpretation:

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

## Documentation

**[Full docs at docs.rigour.run →](https://docs.rigour.run/)**

| | |
|:---|:---|
| [Getting Started](https://docs.rigour.run/getting-started/installation) | Install and run in 60 seconds |
| [Configuration](https://docs.rigour.run/getting-started/configuration) | Customize quality gates |
| [AST Gates](./docs/AST_GATES.md) | Deep dive on structural analysis |
| [Fix Packet Schema](./docs/FIX_PACKET.md) | v2 diagnostic format |
| [MCP Integration](https://docs.rigour.run/mcp/mcp-server) | Agent setup guides |
| [Philosophy](./docs/PHILOSOPHY.md) | Why Rigour exists |
| [Enterprise CI/CD](./docs/ENTERPRISE.md) | GitHub Actions patterns |

---

## Prior Art

The [Technical Specification](./docs/SPEC.md) (published January 2026) establishes public disclosure of the "Agentic Quality Gate Feedback Loop" — the specific combination of automated local gates and agent-specific Fix Packets described in this system.

---

## License

MIT © [Rigour Labs](https://github.com/rigour-labs)

Built by [Ashutosh](https://github.com/erashu212) — enforcing the engineering standards that AI agents skip.
