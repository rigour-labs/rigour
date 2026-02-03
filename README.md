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
npx rigour init     # Initialize quality gates
npx rigour check    # Verify code quality
npx rigour run -- claude "Build feature X"  # Agent loop
```

---

### 🛑 The "Vibe Coding" Trap

AI agents often fall into a cycle of **"Guess and Hope"**:
1. Agent makes a change.
2. Agent **claims** "Task 100% complete" or "CI will pass now."
3. Agent **pushes** to remote.
4. **CI Fails** (Type error, lint failure, broken test).

This is "Vibe Coding"—the agent is hallucinating success based on narrative, not execution.

**Rigour breaks this cycle.** It forces the agent to face the same cold, hard verification tools (ruff, mypy, vitest) that CI runs, but **locally and immediately.** Rigour turns a "claim of victory" into a "proof of execution."

---

## 🔄 How It Works

```
Agent writes code → Rigour checks → FAIL? → Fix Packet → Agent retries → PASS ✓
```

The `rigour run` command loops until your agent achieves PASS or hits max iterations.

### 🌗 Rigour Modes

| Mode | Control | Use Case | Loop |
| :--- | :--- | :--- | :--- |
| **Advisor** | Suggestive | Code reviews & IDE suggestions | Single pass |
| **Supervisor** | Enforcement | CI/CD gates & Autonomous agents | Iterative (Auto-fix) |

> [!TIP]
> This workflow uses **Supervisor mode** for CI/CD, ensuring that any AI-generated code meets all quality gates before merge.


---

## ⚙️ What Gets Checked

| Gate | Description |
|:---|:---|
| **File Size** | Max lines per file (default: 300-500) |
| **Hygiene** | No TODO/FIXME comments allowed |
| **Complexity** | Cyclomatic complexity limits (AST-based) |
| **Required Docs** | SPEC.md, ARCH.md, README must exist |
| **Safety Rails** | Protected paths, max files changed |
| **Context Alignment** | Prevents drift by anchoring on project patterns |

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

## 🛠️ CLI Commands Reference

For a complete reference, visit [docs.rigour.run/cli/commands](https://docs.rigour.run/cli/commands).

| Command | Purpose |
| :--- | :--- |
| `rigour check` | Validates staged changes against safety rules |
| `rigour check --ci` | CI mode with appropriate output |
| `rigour init` | Setup Rigour in project |
| `rigour explain` | Detailed explanation of validation results |
| `rigour run` | Supervisor loop for iterative refinement |
| `rigour studio` | Dashboard for monitoring |

---

## 🧪 CI Integration

```yaml
- run: npx rigour check --ci
```

See [full example](./docs/ENTERPRISE.md) for GitHub Actions setup.

---

## 📜 License

MIT © [Rigour Labs](https://github.com/rigour-labs)

> *"Rigour adds the engineering."*
