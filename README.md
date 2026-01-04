# 🛡️ Rigour

[![npm version](https://img.shields.io/npm/v/@rigour-labs/cli?color=cyan&label=cli)](https://www.npmjs.com/package/@rigour-labs/cli)
[![npm downloads](https://img.shields.io/npm/dm/@rigour-labs/cli?color=blue)](https://www.npmjs.com/package/@rigour-labs/cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**Local-first quality gates for AI-generated code.**  
Rigour forces AI agents to meet strict engineering standards before marking tasks "Done".

> **Zero cloud. Zero telemetry. PASS/FAIL is always free.**

---

## 🚀 Quick Start

```bash
npx @rigour-labs/cli init     # Initialize quality gates
npx @rigour-labs/cli check    # Verify code quality
npx @rigour-labs/cli run -- claude "Build feature X"  # Agent loop
```

---

## 🎯 The Problem

AI agents are powerful but chaotic. They:
- Leave `TODO`s everywhere
- Create 500-line "god files"
- Ignore architectural boundaries
- Claim "Done" when the code is broken

**Rigour stops this.** It injects a deterministic feedback loop that blocks closure until PASS.

---

## 🔄 How It Works

```
Agent writes code → Rigour checks → FAIL? → Fix Packet → Agent retries → PASS ✓
```

The `rigour run` command loops until your agent achieves PASS or hits max iterations.

---

## ⚙️ What Gets Checked

| Gate | Description |
|:---|:---|
| **File Size** | Max lines per file (default: 300-500) |
| **Hygiene** | No TODO/FIXME comments allowed |
| **Complexity** | Cyclomatic complexity limits (AST-based) |
| **Required Docs** | SPEC.md, ARCH.md, README must exist |
| **Safety Rails** | Protected paths, max files changed |

---

## 🤖 Works With

- **Claude Code**: `rigour run -- claude "..."`
- **Cursor / Cline / Gemini**: Via high-fidelity MCP server (`rigour_check`, `rigour_explain`)

---

## 📖 Documentation

**[📚 Full Documentation →](https://docs.rigour.run/)**

| Quick Links | |
|:---|:---|
| [Getting Started](https://docs.rigour.run/getting-started/installation) | Install and run in 60 seconds |
| [CLI Reference](https://docs.rigour.run/cli/commands) | All commands and options |
| [Configuration](https://docs.rigour.run/getting-started/configuration) | Customize quality gates |
| [MCP Integration](https://docs.rigour.run/mcp/mcp-server) | AI agent setup |
| [Concepts](https://docs.rigour.run/concepts/philosophy) | How Rigour works |

---

## 🧪 CI Integration

```yaml
- run: npx @rigour-labs/cli check --ci
```

See [full example](./docs/ENTERPRISE.md) for GitHub Actions setup.

---

## 📜 License

MIT © [Rigour Labs](https://github.com/rigour-labs)

> *"Rigour adds the engineering."*
