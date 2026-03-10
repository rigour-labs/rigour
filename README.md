# Rigour

[![npm version](https://img.shields.io/npm/v/@rigour-labs/cli?color=cyan&label=cli)](https://www.npmjs.com/package/@rigour-labs/cli)
[![npm downloads](https://img.shields.io/npm/dm/@rigour-labs/cli?color=blue)](https://www.npmjs.com/package/@rigour-labs/cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**AI Agent Governance. One command. Every agent.**

Rigour is the security and quality layer that sits between AI coding agents and your codebase. Think of it as an antivirus for AI-generated code — with both local intelligence and cloud-powered deep analysis.

It governs three things no one else does:

1. **What goes IN** — DLP intercepts credentials before they reach any agent
2. **What comes OUT** — Quality gates catch hallucinated imports, unsafe patterns, and drift
3. **What gets PERSISTED** — Memory governance prevents secrets from leaking into agent memory

Works with **Claude Code, Cursor, Cline, Windsurf, and GitHub Copilot**. One `rigour init` sets up everything — hooks, MCP tools, rules, DLP, and pattern indexing.

## Quick Start

```bash
npx @rigour-labs/cli init
```

This single command:
- Creates `rigour.yml` with auto-detected project settings
- Installs real-time hooks for every detected agent (block mode)
- Configures MCP server for agent-cooperative governance
- Enables DLP — credentials intercepted before reaching agents
- Builds a pattern index for instant duplicate detection
- All local-first. Code never leaves your machine.

## How It Works

Rigour uses a **two-tier supervision model**:

**Tier 1 — Hooks (automatic, <100ms):** Inline checks that fire on every file write. The agent cannot bypass these. Catches secrets, hallucinated imports, file size violations, and command injection in real time.

**Tier 2 — MCP Tools (agent-cooperative):** The agent is instructed to call Rigour tools at key moments — `rigour_recall` before starting, `rigour_check_pattern` before creating code, `rigour_check` before declaring done. Rules files (`.cursor/rules/rigour.mdc`, `CLAUDE.md`, `.clinerules`) enforce this workflow.

### AI Agent DLP (Data Loss Prevention)

Every AI agent gets a pre-input hook that scans for **29 credential patterns** in real time (<50ms): cloud keys (AWS, GCP, Azure), API tokens (OpenAI, GitHub, Stripe, etc.), private keys (RSA, EC, ED25519), database URLs, JWTs, and more. Includes anti-evasion hardening with Unicode normalization, entropy detection, and JSON deserialization scanning.

### Quality Gates (27+ deterministic)

Deterministic PASS/FAIL gates that catch what AI agents get wrong:

- **Hallucinated imports** — language-aware resolution for 8 languages
- **Phantom APIs** — non-existent stdlib/framework methods the LLM invented
- **Duplication drift** — three-pass detection: MD5 exact → AST Jaccard (tree-sitter) → semantic embedding (all-MiniLM-L6-v2)
- **Style drift** — fingerprints naming conventions against project baseline
- **Logic drift** — tracks comparison operators, branch counts, return statements
- **Security patterns** — hardcoded secrets, command injection, SQL injection, XSS
- **Dependency bloat** — unused deps, heavy alternatives (moment→dayjs)
- **Test quality** — empty tests, tautological assertions, mock abuse

### Deep Analysis (Local RL + Cloud Learning)

Rigour's deep analysis is not "ask an LLM to review code." It runs a **three-stage pipeline** where the model is constrained by ground truth:

1. **Fact extraction (deterministic)** — AST parsing, semantic embeddings, style fingerprints, logic baselines, dependency graphs. No LLM involved.
2. **LLM interpretation** — The model receives structured facts (not raw code). Focused on SOLID principles, design patterns, architecture.
3. **Verification (deterministic)** — Every LLM finding is cross-referenced against AST facts. Hallucinated findings are discarded.

**Local mode** ships a GGUF sidecar model (Qwen2.5-Coder) that runs on any CPU — no GPU, no API key, no data leaving your machine. The **Rigour Brain** (SQLite) learns from every scan: patterns are reinforced when seen repeatedly, decay when absent, and promote to hard rules at high strength. This is the "local RL" — your project's own learned immune system.

**Cloud mode** sends structured facts to your chosen provider (Claude, OpenAI, Gemini, etc.) via BYOK for deeper analysis. Same three-stage pipeline, more powerful model.

```bash
rigour check --deep              # Local sidecar (lite, any CPU)
rigour check --deep --pro        # Local sidecar (full, code-specialized)
rigour check --deep --provider claude -k sk-ant-xxx  # Cloud BYOK
```

### Pattern Index

Pre-built index of all functions, classes, and components in your codebase (`.rigour/patterns.json`). Enables O(1) duplicate detection via the `rigour_check_pattern` MCP tool — instead of the agent scanning every file and wasting tokens.

```bash
rigour index                     # Build/update pattern index
rigour index --semantic          # Include semantic embeddings
```

### Memory & Skills Governance

Agents write to native memory files (`.cursorrules`, `CLAUDE.md`, `.windsurf/memories/`). Rigour intercepts these writes and forces agents to use `rigour_remember` instead, where every value is DLP-scanned before persistence. Recall is also gated — credentials stored before DLP was installed are blocked on read.

## Install

```bash
# npx (fastest)
npx @rigour-labs/cli --version

# Homebrew
brew tap rigour-labs/tap && brew install rigour

# Global npm
npm install -g @rigour-labs/cli
```

## Core Commands

```bash
rigour init                          # Full setup: config, hooks, MCP, DLP, pattern index
rigour check                         # Run all quality gates
rigour check --deep                  # + local LLM deep analysis
rigour check --deep --pro            # + full deep model
rigour scan                          # Zero-config scan (no rigour.yml needed)
rigour hooks init --tool cursor      # Install hooks for a specific tool
rigour hooks check --files src/a.ts  # Fast file check (<100ms)
rigour index                         # Build pattern index
rigour brain                         # Show local memory status
rigour brain --compact               # Prune old data, reclaim disk
rigour studio                        # Visual dashboard
rigour doctor                        # Diagnose install + readiness
```

## MCP Integration

Add Rigour as an MCP server — agents get quality gates, governed memory, and pattern checking as tool calls:

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

**Key MCP tools:**

| Tool | Purpose |
|---|---|
| `rigour_check` | Run all quality gates — MUST call before declaring done |
| `rigour_check_pattern` | Check if function/component already exists — MUST call before creating code |
| `rigour_recall` | Load project memory and conventions — MUST call at task start |
| `rigour_remember` | DLP-gated persistent memory |
| `rigour_review` | PR diff analysis |
| `rigour_security_audit` | CVE scan on dependencies |

## CI

```yaml
- run: npx @rigour-labs/cli check --ci
```

## Demo

```bash
rigour demo                                              # Quick demo with hooks + gates
rigour demo --cinematic                                  # Full demo: hooks, fix, cache hit
rigour demo --repo https://github.com/fastapi/fastapi    # Run on any public repo
```

## Rigovo Ecosystem

Rigour is part of the **Rigovo AI-Native Engineering Platform**:

| Product | What it does | Link |
|---|---|---|
| **Rigour** | Quality gates for AI-generated code (27+ gates + local LLM) | [GitHub](https://github.com/rigour-labs/rigour) |
| **Rigovo HR** | AI-powered technical hiring — Maya AI interviewer, 15-signal verification | [rigovo.com](https://rigovo.com) |
| **Rigovo Virtual Team** | Multi-agent software delivery with deterministic quality gates | [GitHub](https://github.com/rigovo/rigovo-virtual-team) |

## Documentation

- [Quick Start](./docs/QUICK_START.md)
- [Configuration](./docs/CONFIGURATION.md)
- [Deep Analysis](./docs/DEEP_ANALYSIS.md)
- [Accuracy Policy](./docs/ACCURACY.md)
- [MCP Integration](./docs/MCP_INTEGRATION.md)
- [OWASP Mapping](./docs/OWASP_MAPPING.md)
- [Docs Site](https://docs.rigour.run/)

## License

MIT © [Rigour Labs](https://github.com/rigour-labs)
