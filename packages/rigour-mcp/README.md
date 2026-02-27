# 🛡️ Rigour MCP Server

**The Quality Gate for AI-Assisted Engineering.**

Rigour is a local-first Model Context Protocol (MCP) server that forces AI agents (Claude, Cursor, Windsurf, etc.) to meet strict engineering standards before marking tasks as complete.

[![Registry](https://img.shields.io/badge/MCP-Registry-brightgreen)](https://github.com/mcp)
[![npm version](https://img.shields.io/npm/v/@rigour-labs/mcp?color=cyan)](https://www.npmjs.com/package/@rigour-labs/mcp)

---

## 🚀 Overview

Rigour moves code quality enforcement from the "Post-Commit" phase to the "In-Progress" phase. By running as an MCP server inside your editor, it provides the AI with a deterministic PASS/FAIL loop, preventing "Vibe Coding" and broken builds.

### Key Features:
- **Quality Gates**: 23 deterministic checks for file size, complexity, hygiene, security, and AI-native drift detection.
- **8-Language Support**: JS/TS, Python, Go, Ruby, C#/.NET, Rust, Java, and Kotlin — with stdlib whitelists, dependency manifest parsing, and project-relative import resolution.
- **Real-Time Hooks**: Sub-200ms file-write hooks for Claude Code, Cursor, Cline, and Windsurf — catches issues as the AI writes, not after CI.
- **OWASP LLM Top 10**: Strong coverage on all 10 risks from the OWASP Top 10 for LLM-Generated Code, with 25+ security patterns.
- **Two-Score System**: Separate AI Health Score and Structural Score with provenance tracking.
- **Context Memory**: Persistent memory that tracks project rules and patterns across sessions.
- **Pattern Reinvention Blocking**: Warns or blocks the AI when it tries to rewrite existing utilities.
- **Security Audits**: Real-time CVE detection for dependencies the AI is suggesting.
- **Multi-Agent Governance**: Agent registration, scope isolation, checkpoint supervision, and verified handoffs for multi-agent workflows.
- **Industry Presets**: SOC2, HIPAA, FedRAMP-ready gate configurations.
- **Local-First**: Deterministic gates run locally. If deep analysis is configured with a cloud provider, code context may be sent to that provider.

---

## 🛠️ Available Tools

### Core Tools

| Tool | Description |
|:---|:---|
| `rigour_check` | Runs all configured quality gates on the current workspace. |
| `rigour_explain` | Explains why a specific gate failed and provides actionable fix instructions. |
| `rigour_status` | Quick PASS/FAIL check with JSON-friendly output for polling. |
| `rigour_get_fix_packet` | Retrieves prioritized Fix Packet (v2) with severity and provenance. |
| `rigour_list_gates` | Lists all configured quality gates and their thresholds. |
| `rigour_get_config` | Returns the current rigour.yml configuration. |
| `rigour_check_pattern` | Checks if a proposed code pattern already exists in the codebase. |
| `rigour_remember` | Stores project-specific context or rules in Rigour's persistent memory. |
| `rigour_recall` | Retrieves stored context to guide AI generation. |
| `rigour_forget` | Removes a stored memory by key. |
| `rigour_security_audit` | Runs a live CVE check on project dependencies. |
| `rigour_run` | Executes a command under Rigour supervision with human arbitration. |
| `rigour_run_supervised` | Full supervisor mode — iterative command + gate check loop. |
| `rigour_review` | High-fidelity code review on a PR diff against all quality gates. |

### Real-Time Hooks (v3.0)

| Tool | Description |
|:---|:---|
| `rigour_hooks_check` | Run fast hook checker on specific files (<100ms). Catches: hardcoded secrets, hallucinated imports, command injection, file size. |
| `rigour_hooks_init` | Generate hook configs for Claude, Cursor, Cline, or Windsurf. Installs real-time checks on every file write. |

### Frontier Model Tools (v2.14+)

For next-gen multi-agent workflows (Opus 4.6, GPT-5.3-Codex):

| Tool | Description |
|:---|:---|
| `rigour_agent_register` | Register agent in session with scope conflict detection. |
| `rigour_agent_deregister` | Remove agent from session when work is complete. |
| `rigour_checkpoint` | Record quality checkpoint with drift detection. |
| `rigour_handoff` | Initiate task handoff to another agent. |
| `rigour_handoff_accept` | Accept a pending handoff from another agent. |

---

## 🌐 Language Support

Hallucinated import detection with full stdlib whitelists and dependency manifest parsing:

| Language | Stdlib | Dependency Manifest | Import Patterns |
|:---|:---|:---|:---|
| **JavaScript/TypeScript** | Node.js 22.x builtins | `package.json` | `import`, `require()`, `export from` |
| **Python** | 160+ stdlib modules (3.12+) | Local module resolution | `import`, `from ... import` |
| **Go** | 150+ stdlib packages (1.22+) | `go.mod` module path | `import "..."`, aliased imports |
| **Ruby** | 80+ stdlib gems (3.3+ MRI) | `Gemfile`, `.gemspec` | `require`, `require_relative` |
| **C# / .NET** | .NET 8 framework namespaces | `.csproj` (NuGet PackageReference) | `using`, `using static` |
| **Rust** | `std`/`core`/`alloc`/`proc_macro` | `Cargo.toml` (with `-` → `_`) | `use`, `extern crate`, `pub use` |
| **Java** | `java.*`/`javax.*`/`jakarta.*` | `build.gradle`, `pom.xml` | `import`, `import static` |
| **Kotlin** | `kotlin.*`/`kotlinx.*` + Java interop | `build.gradle.kts` | `import` |

---

## 📦 Installation

### 1. Install via npm
```bash
npm install -g @rigour-labs/mcp
```

### 2. Configure your IDE

#### Cursor / Claude Desktop
Add the following to your MCP settings:
```json
{
  "mcpServers": {
    "rigour": {
      "command": "npx",
      "args": ["-y", "@rigour-labs/mcp"],
      "env": {
        "RIGOUR_CWD": "/path/to/your/project"
      }
    }
  }
}
```

---

## 📖 Documentation

For full configuration and advanced usage, visit **[docs.rigour.run](https://docs.rigour.run)**.

---

## 📜 License

MIT © [Rigour Labs](https://github.com/rigour-labs)
