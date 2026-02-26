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

### 1) Choose Installation Method

Use one of these:

```bash
# Option A: No install (quickest)
npx @rigour-labs/cli --version

# Option B: Homebrew (macOS/Linux users already using brew)
brew tap rigour-labs/tap
brew install rigour
rigour --version

# Option C: Global npm install
npm install -g @rigour-labs/cli
rigour --version
```

### 2) First Commands To Run In Your Repo

If using `npx`, prefix each command with `npx @rigour-labs/cli`.
If installed (`brew` or global npm), use `rigour`.

```bash
rigour scan                 # Zero-config scan, immediate findings
rigour init                 # Generate rigour.yml + docs
rigour check                # Run quality gates (PASS/FAIL)
rigour hooks init           # Enable real-time hooks for Claude/Cursor/Cline/Windsurf
rigour check --deep --pro   # Deep semantic analysis (larger local model)
```

### 3) CI Command

```bash
npx @rigour-labs/cli check --ci
```

---

## Instant Scan

```bash
npx @rigour-labs/cli scan
```

Runs with zero setup: auto-detects project profile and stack, executes existing gates, and highlights high-impact issues immediately (hallucinated imports, deprecated/security patterns, async safety, and more).

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
| **Hallucinated Imports** | Imports referencing packages that don't exist (8 languages — see below) | `critical` |
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

Supports **8 languages**: TypeScript, JavaScript, Python, Go, Ruby, C#/.NET, Rust, Java, and Kotlin.

### Hallucinated Import Detection — Language Matrix

| Language | Stdlib Whitelist | Dependency Manifest | Import Patterns |
|:---|:---|:---|:---|
| **JS/TS** | Node.js 22.x builtins | `package.json` | `import`, `require()`, `export from` |
| **Python** | 160+ modules (3.12+) | Local module resolution | `import`, `from ... import` |
| **Go** | 150+ packages (1.22+) | `go.mod` module path | `import "..."`, aliased imports |
| **Ruby** | 80+ gems (3.3+ MRI) | `Gemfile`, `.gemspec` | `require`, `require_relative` |
| **C# / .NET** | .NET 8 framework namespaces | `.csproj` NuGet refs | `using`, `using static` |
| **Rust** | `std`/`core`/`alloc` crates | `Cargo.toml` (dash→underscore) | `use`, `extern crate`, `pub use` |
| **Java** | `java.*`/`javax.*`/`jakarta.*` | `build.gradle`, `pom.xml` | `import`, `import static` |
| **Kotlin** | `kotlin.*`/`kotlinx.*` + Java | `build.gradle.kts` | `import` |

### Deep Analysis (LLM-Powered)

Semantic code quality checks across 40+ categories, enabled with `--deep`:

| Category | What It Detects | Examples |
|:---|:---|:---|
| **SOLID Principles** | SRP, OCP, LSP, ISP, DIP violations | God classes, classes with too many reasons to change |
| **Design Patterns** | God classes, feature envy, shotgun surgery, data clumps | Functions too interested in other objects' state |
| **DRY** | Code duplication, copy-paste violations | Identical logic blocks across files |
| **Error Handling** | Empty catches, error swallowing, missing checks | Silent failures, panic in libraries |
| **Concurrency** | Race conditions, goroutine leaks, missing context | Unhandled goroutines, mutex scope issues (Go) |
| **Testing** | Test quality, coverage gaps, test coupling | Untested public functions, implementation-coupled tests |
| **Architecture** | Circular dependencies, package cohesion, API design | Modules that shouldn't depend on each other |
| **Language Idioms** | Language best practices, naming conventions | Non-idiomatic code, inconsistent naming |

Requires LLM provider (Anthropic, OpenAI, or local model). Results verified by AST to prevent hallucination.

```bash
rigour check --deep --provider anthropic
```

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
  deep:
    enabled: false  # Enable with --deep or set to true
    provider: anthropic
    model: claude-sonnet-4-5-20250514
    agents: 1
    checks:
      - solid
      - dry
      - design_patterns
      - error_handling
      - language_idioms
      - test_quality
      - architecture
      - code_smells
      - concurrency
      - performance

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

**Settings file** (`~/.rigour/settings.json`) stores API keys:

```json
{
  "anthropic_api_key": "sk-ant-...",
  "openai_api_key": "sk-...",
  "deep_provider": "anthropic",
  "deep_model": "claude-sonnet-4-5-20250514"
}
```

---

## Architecture

A **pnpm monorepo** with four packages:

| Package | Purpose |
|:---|:---|
| `@rigour-labs/core` | Gate engine, AST analysis, deep analysis pipeline, hooks checker, Fix Packet generation |
| `@rigour-labs/cli` | Commands: `scan`, `init`, `check`, `run`, `demo`, `hooks init`, `studio` |
| `@rigour-labs/mcp` | Model Context Protocol server for agent integration |
| `@rigour-labs/studio` | React-based monitoring dashboard |

**Tech stack:** TypeScript (strict mode), web-tree-sitter, Zod, Commander.js, Vitest, GitHub Actions CI (Ubuntu/macOS/Windows).

### Homebrew Release Automation

`main` releases can auto-update a tap formula at `Formula/rigour.rb`.

Required GitHub secret:
- `HOMEBREW_TAP_GH_TOKEN` (PAT with push access to the tap repo)

Optional GitHub variable:
- `HOMEBREW_TAP_REPO` (defaults to `rigour-labs/homebrew-tap`)

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
| [Deep Analysis](./docs/DEEP_ANALYSIS.md) | LLM-powered semantic code quality (40+ checks) |
| [OWASP LLM Mapping](./docs/OWASP_MAPPING.md) | All 10 OWASP LLM code risks covered |
| [AST Gates](./docs/AST_GATES.md) | Cyclomatic complexity, nesting, tree-sitter, deep analysis pipeline |
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
