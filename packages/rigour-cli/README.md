# @rigour-labs/cli

[![npm version](https://img.shields.io/npm/v/@rigour-labs/cli?color=cyan)](https://www.npmjs.com/package/@rigour-labs/cli)
[![npm downloads](https://img.shields.io/npm/dm/@rigour-labs/cli?color=blue)](https://www.npmjs.com/package/@rigour-labs/cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**Local-first quality gates for AI-generated code.**  
Rigour forces AI agents to meet strict engineering standards before marking tasks "Done".

> **Zero cloud. Zero telemetry. PASS/FAIL is always free.**

## 🚀 Quick Start

```bash
npx rigour init     # Initialize quality gates
npx rigour check    # Verify code quality
npx rigour run -- claude "Build feature X"  # Agent loop
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

| Gate | Description |
|:---|:---|
| **File Size** | Max lines per file (default: 300-500) |
| **Hygiene** | No TODO/FIXME comments allowed |
| **Complexity** | Cyclomatic complexity limits (AST-based) |
| **Required Docs** | SPEC.md, ARCH.md, README must exist |
| **Safety Rails** | Protected paths, max files changed |
| **Context Alignment** | Prevents drift by anchoring on project patterns |

## 🛠️ Commands

| Command | Purpose |
|:---|:---|
| `rigour init` | Setup Rigour in your project |
| `rigour check` | Validate code against quality gates |
| `rigour check --ci` | CI mode with appropriate output |
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
- run: npx rigour check --ci
```

## 📜 License

MIT © [Rigour Labs](https://github.com/rigour-labs)

> *"Rigour adds the engineering."*
