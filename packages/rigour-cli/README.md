# @rigour-labs/cli

[![npm version](https://img.shields.io/npm/v/@rigour-labs/cli?color=cyan)](https://www.npmjs.com/package/@rigour-labs/cli)
[![npm downloads](https://img.shields.io/npm/dm/@rigour-labs/cli?color=blue)](https://www.npmjs.com/package/@rigour-labs/cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**Local-first quality gates for AI-generated code.**  
Rigour forces AI agents to meet strict engineering standards before marking tasks "Done".

> Core gates run locally. Deep analysis can run local or cloud provider mode.

## 🚀 Quick Start

```bash
npx @rigour-labs/cli scan     # Zero-config scan (auto-detect stack)
npx @rigour-labs/cli init     # Initialize quality gates
npx @rigour-labs/cli check    # Verify code quality
npx @rigour-labs/cli run -- claude "Build feature X"  # Agent loop
```

## 🍺 Homebrew

```bash
brew tap rigour-labs/tap
brew install rigour
```

## 🛑 The Problem

AI agents often fall into **"Vibe Coding"**—claiming success based on narrative, not execution:

1. Agent makes a change
2. Agent **claims** "Task 100% complete"
3. **CI Fails** with type errors, lint failures, or broken tests

**Rigour breaks this cycle** by forcing agents to face the same verification tools (ruff, mypy, vitest) that CI runs—locally and immediately.

## 🔄 How It Works

```
Agent writes code → Rigour checks → FAIL? → Fix Packet → Agent retries → PASS ✓
```

## ⚙️ Quality Gates

### Structural & Security Gates
| Gate | Description |
|:---|:---|
| **File Size** | Max lines per file (default: 300-500) |
| **Hygiene** | No TODO/FIXME comments allowed |
| **Complexity** | Cyclomatic complexity limits (AST-based) |
| **Required Docs** | SPEC.md, ARCH.md, README must exist |
| **File Guard** | Protected paths, max files changed |
| **Security Patterns** | XSS, SQL injection, hardcoded secrets, command injection |
| **Context Alignment** | Prevents drift by anchoring on project patterns |

### AI-Native Drift Detection (v2.16+)
| Gate | Description |
|:---|:---|
| **Duplication Drift** | Near-identical functions across files — AI re-invents what it forgot |
| **Hallucinated Imports** | Imports referencing modules that don't exist (JS/TS, Python, Go, Ruby, C#) |
| **Inconsistent Error Handling** | Same error type handled differently across agent sessions |
| **Context Window Artifacts** | Quality degradation within a file — clean top, messy bottom |
| **Async & Error Safety** | Unsafe async/promise patterns, unhandled errors across 6 languages |

### Multi-Language Support
All gates support **TypeScript, JavaScript, Python, Go, Ruby, and C#/.NET**.

## 🛠️ Commands

| Command | Purpose |
|:---|:---|
| `rigour scan` | Zero-config stack-aware scan using existing gates |
| `rigour init` | Setup Rigour in your project |
| `rigour check` | Validate code against quality gates |
| `rigour check --ci` | CI mode with appropriate output |
| `rigour hooks init` | Install real-time hooks for supported tools |
| `rigour hooks check --files ...` | Run fast hook gates on specific files |
| `rigour explain` | Detailed explanation of validation results |
| `rigour run` | Supervisor loop for iterative refinement |
| `rigour studio` | Dashboard for monitoring |
| `rigour index` | Build semantic index of codebase patterns |

## 🤖 Works With

- **Claude Code**: `rigour run -- claude "..."`
- **Cursor / Cline / Gemini**: Via MCP server (`rigour_check`, `rigour_explain`)

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

> *"Rigour adds the engineering."*
