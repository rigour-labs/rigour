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
- **Cursor**: `.cursor/rules` + MCP integration
- **Cline / Gemini / Codex**: Via CLI or MCP

---

## 📖 Documentation

| Doc | Description |
|:---|:---|
| [Quick Start](./docs/QUICK_START.md) | Get running in 60 seconds |
| [Configuration](./docs/CONFIGURATION.md) | Customize gates |
| [Presets](./docs/PRESETS.md) | Role-based standards (ui/api/data) |
| [Agent Integration](./docs/AGENT_INTEGRATION.md) | Cursor, Claude, Cline setup |
| [Fix Packet Schema](./docs/specs/FIX_PACKET_SCHEMA.md) | Agent feedback contract |

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
