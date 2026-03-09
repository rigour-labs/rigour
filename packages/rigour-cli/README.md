# @rigour-labs/cli

[![npm version](https://img.shields.io/npm/v/@rigour-labs/cli?color=cyan)](https://www.npmjs.com/package/@rigour-labs/cli)
[![npm downloads](https://img.shields.io/npm/dm/@rigour-labs/cli?color=blue)](https://www.npmjs.com/package/@rigour-labs/cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**AI Agent Governance CLI — quality gates, DLP, drift detection, and deep analysis.**
Rigour governs what goes IN (DLP), what comes OUT (quality gates), and what gets PERSISTED (memory governance).

> Core gates run locally. Deep analysis can run local or cloud provider mode.

## 🚀 Quick Start

```bash
npx @rigour-labs/cli scan     # Zero-config scan (auto-detect stack)
npx @rigour-labs/cli init     # Initialize config, hooks, DLP, governance
npx @rigour-labs/cli check    # Verify code quality (27+ gates)
npx @rigour-labs/cli run -- claude "Build feature X"  # Agent loop
```

## 🍺 Homebrew

```bash
brew tap rigour-labs/tap
brew install rigour
```

## 🛑 The Problem

AI agents are powerful but ungoverned. They claim success based on narrative, not execution. Credentials get cached in agent memory. Imports get hallucinated. Code quality drifts across sessions.

**Rigour breaks this cycle** with deterministic PASS/FAIL gates, credential interception, and memory governance — all local-first.

## 🔄 How It Works

```
Agent writes code → Rigour checks → FAIL? → Fix Packet → Agent retries → PASS ✓
DLP: User input → Credential scan → BLOCK before agent sees it
Memory: Agent writes CLAUDE.md → Rigour intercepts → Forces rigour_remember (DLP-scanned)
```

## ⚙️ Quality Gates (27+ Deterministic)

### Structural & Security Gates
| Gate | Description |
|:---|:---|
| **File Size** | Max lines per file (default: 300-500) |
| **Content Hygiene** | No TODO/FIXME comments allowed |
| **AST Analysis** | Cyclomatic complexity, method count, nesting depth, function length |
| **Required Docs** | SPEC.md, ARCH.md, README must exist |
| **File Guard** | Protected paths, max files changed |
| **Security Patterns** | XSS, SQL injection, hardcoded secrets, command injection, path traversal |
| **Frontend Secret Exposure** | API keys in client-side bundles |
| **Deprecated APIs** | Node, Python, Web, Go, C#, Java deprecated usage |
| **Test Quality** | Empty tests, tautological assertions, mock-heavy, snapshot abuse |
| **Side-Effect Safety** | Unbounded timers, recursive depth, resource lifecycle, retry loops |

### AI-Native Drift Detection
| Gate | Description |
|:---|:---|
| **Hallucinated Imports** | Imports referencing non-existent modules (JS/TS, Python, Go, Ruby, C#, Rust, Java, Kotlin) |
| **Phantom APIs** | Non-existent stdlib/framework methods the LLM invented |
| **Promise Safety** | Unhandled async, unsafe JSON.parse, floating fetch across 6 languages |
| **Duplication Drift** | Three-pass: MD5 exact → AST Jaccard (tree-sitter) → semantic embedding (384D cosine) |
| **Style Drift** | Naming conventions, error handling, import style fingerprinted against project baseline |
| **Logic Drift** | Comparison operators (>= → >), branch counts, return statements tracked per function |
| **Context Window Artifacts** | Quality degradation within long files — clean top, messy bottom |
| **Inconsistent Error Handling** | Same error type handled differently across sessions |
| **Dependency Bloat** | Unused deps, heavy alternatives (moment→dayjs), duplicate purpose packages |

### Agent Governance
| Gate | Description |
|:---|:---|
| **Memory Governance** | Blocks agent writes to CLAUDE.md, .clinerules, .windsurf/memories/ |
| **Skills Governance** | Blocks agent writes to .claude/skills/, .cursor/rules/ |
| **Governance DLP** | Scans content written to any governed file for credentials |

### Two-Score System
Every failure carries a provenance tag (`ai-drift`, `traditional`, `security`, `governance`) and contributes to two sub-scores: **AI Health Score** (0–100) and **Structural Score** (0–100).

## 🔒 AI Agent DLP (Data Loss Prevention)

Real-time credential interception via PreToolUse hooks — blocks credentials before agents see them.

- **29 credential patterns**: AWS, GCP, Azure, OpenAI, Anthropic, GitHub, Stripe, private keys, database URLs, JWTs, CI/CD tokens
- **Anti-evasion**: Unicode normalization, zero-width char removal, bidi control stripping, Shannon entropy detection (>4.5 bits)
- **Compliance mapped**: SOC2-CC6.1, HIPAA-164.312, PCI-DSS-3.4/3.5/6.5, OWASP-A2, CWE-798

## 🔗 Real-Time Hooks

Two-tier supervision: inline hooks (<200ms per file write) + checkpoint suite (full gates).

```bash
rigour hooks init                    # auto-detect tool, install hooks + DLP
rigour hooks init --tool all         # all tools at once
rigour hooks init --block            # exit code 2 on failures (strict mode)
rigour hooks init --no-dlp           # skip DLP hooks
rigour hooks check --files src/a.ts  # manual fast check
```

**Supported tools:** Claude Code, Cursor, Cline, Windsurf — each with quality (post-write) and DLP (pre-write) hooks.

## 🧠 Deep Analysis (LLM-Powered)

Five-signal extraction → LLM interpretation → deterministic verification pipeline.

```bash
rigour check --deep                  # Local sidecar (Qwen3.5-0.8B, any CPU)
rigour check --deep --pro            # Full model (Qwen2.5-Coder-1.5B)
rigour check --deep --provider claude -k sk-ant-xxx  # Cloud BYOK
```

## 🌐 Multi-Language Support

Hallucinated import detection with stdlib whitelists and dependency manifest parsing:

**JS/TS** (Node.js builtins, package.json) · **Python** (160+ stdlib, local modules) · **Go** (150+ stdlib, go.mod) · **Ruby** (80+ stdlib, Gemfile) · **C#/.NET** (.NET 8 namespaces, .csproj) · **Rust** (std/core/alloc, Cargo.toml) · **Java** (java/javax/jakarta, build.gradle/pom.xml) · **Kotlin** (kotlin/kotlinx + Java interop, build.gradle.kts)

## 🛠️ Commands

| Command | Purpose |
|:---|:---|
| `rigour scan` | Zero-config stack-aware scan (auto-detect) |
| `rigour scan --deep` | Zero-config + local LLM deep analysis |
| `rigour init` | Setup config, hooks, DLP, governance |
| `rigour check` | Full repository quality gates |
| `rigour check --ci` | CI mode with minimal output |
| `rigour check --deep` | + local LLM analysis |
| `rigour hooks init` | Install real-time hooks for detected tools |
| `rigour hooks check --files ...` | Fast hook gates on specific files |
| `rigour explain` | Detailed explanation of failures |
| `rigour run` | Supervisor loop for agent refinement |
| `rigour run --supervised` | Full supervisor mode (iterative command + gate loop) |
| `rigour studio` | Dashboard for monitoring |
| `rigour brain` | Local memory status (SQLite) |
| `rigour brain --compact` | Prune old findings, reclaim disk |
| `rigour doctor` | Diagnose install + deep readiness |
| `rigour export-audit` | Export compliance audit report (JSON/Markdown) |
| `rigour demo` | Live demo on synthetic or real repos |
| `rigour settings` | Manage API keys and provider config |

## 🤖 Works With

- **Claude Code**: `rigour run -- claude "..."` + real-time hooks
- **Cursor**: Via MCP server + `.cursor/hooks.json`
- **Cline**: Via MCP server + `.clinerules/hooks/` scripts
- **Windsurf**: Via MCP server + `.windsurf/hooks.json`
- **Gemini**: Via MCP server (`rigour_check`, `rigour_explain`)
- **GitHub Actions**: `npx @rigour-labs/cli check --ci`

## 📖 Documentation

**[📚 Full Documentation →](https://docs.rigour.run/)**

| Quick Links | |
|:---|:---|
| [Getting Started](https://docs.rigour.run/getting-started) | Install and run in 60 seconds |
| [CLI Reference](https://docs.rigour.run/cli/commands) | All commands and options |
| [Configuration](https://docs.rigour.run/reference/configuration) | Customize quality gates |
| [MCP Integration](https://docs.rigour.run/mcp/mcp-server) | AI agent setup |

## 🧪 CI Integration

```yaml
- run: npx @rigour-labs/cli check --ci
```

## 📜 License

MIT © [Rigour Labs](https://github.com/rigour-labs)
