# 🛡️ Rigour MCP Server

**AI Agent Governance via Model Context Protocol — quality gates, DLP, drift detection, and deep analysis.**

Rigour is a local-first MCP server that governs AI agents (Claude, Cursor, Cline, Windsurf) with deterministic quality gates, credential warnings, and memory governance.

[![Registry](https://img.shields.io/badge/MCP-Registry-brightgreen)](https://github.com/mcp)
[![npm version](https://img.shields.io/npm/v/@rigour-labs/mcp?color=cyan)](https://www.npmjs.com/package/@rigour-labs/mcp)

---

## 🚀 Overview

Rigour moves code quality enforcement from "Post-Commit" to "In-Progress." By running as an MCP server inside your editor, it provides the AI with a deterministic PASS/FAIL loop, preventing "Vibe Coding" and broken builds.

### Key Features:

- **27+ Quality Gates**: Deterministic checks for file size, complexity, hygiene, security, and AI-native drift detection.
- **8-Language Hallucination Detection**: JS/TS, Python, Go, Ruby, C#/.NET, Rust, Java, and Kotlin — with stdlib whitelists, dependency manifest parsing, and project-relative import resolution.
- **AI Agent DLP**: 29 credential patterns intercepted before agents see them (<50ms). Anti-evasion: unicode normalization, entropy detection, bidi stripping.
- **Memory & Skills Governance**: Blocks agent writes to native memory files (CLAUDE.md, .clinerules, .windsurf/memories/); forces DLP-scanned `rigour_remember` instead.
- **Real-Time Hooks**: Sub-200ms file-write hooks for Claude Code, Cursor, Cline, and Windsurf — catches issues as the AI writes, not after CI.
- **Two-Score System**: Separate AI Health Score and Structural Score with provenance tracking (`ai-drift`, `traditional`, `security`, `governance`).
- **Deep Analysis**: Five-signal LLM pipeline (AST facts, embeddings, style fingerprints, logic baselines, dependency graphs) with deterministic verification.
- **Multi-Agent Governance**: Agent registration, scope isolation, checkpoint supervision, and verified handoffs.
- **Industry Presets**: SOC2, HIPAA, FedRAMP-ready gate configurations.
- **Local-First**: Deterministic gates run locally. Cloud deep analysis is opt-in BYOK.

---

## 🛠️ Available Tools (25)

### Core Quality Tools

| Tool | Description |
|:---|:---|
| `rigour_check` | Runs all configured quality gates on the current workspace. |
| `rigour_explain` | Explains why a specific gate failed with actionable fix instructions. |
| `rigour_status` | Quick PASS/FAIL check with JSON-friendly output for polling. |
| `rigour_get_fix_packet` | Retrieves prioritized Fix Packet (v2) with severity and provenance. |
| `rigour_list_gates` | Lists all configured quality gates and their thresholds. |
| `rigour_get_config` | Returns the current rigour.yml configuration. |
| `rigour_check_pattern` | Checks if a proposed code pattern already exists in the codebase. |
| `rigour_security_audit` | Runs a live CVE check on project dependencies. |
| `rigour_review` | High-fidelity code review on a PR diff against all quality gates. |

### Memory & Context Tools

| Tool | Description |
|:---|:---|
| `rigour_remember` | DLP-gated persistent memory — scans values before storing. |
| `rigour_recall` | DLP-gated recall — blocks tainted memories on read. |
| `rigour_forget` | Removes a stored memory by key. |

### Real-Time Hooks & DLP

| Tool | Description |
|:---|:---|
| `rigour_hooks_check` | Fast hook checker on specific files (<200ms). Also accepts `text` param for DLP mode — scans user input for credentials (AWS keys, API tokens, database URLs, private keys, JWTs) before agent processing. |
| `rigour_hooks_init` | Generate hook configs for Claude, Cursor, Cline, or Windsurf. Installs quality hooks + DLP pre-input hooks by default. Pass `dlp: false` to skip DLP. |

### Deep Analysis

| Tool | Description |
|:---|:---|
| `rigour_check_deep` | LLM-powered code review with five-signal extraction → verification pipeline. Local-first or cloud BYOK. |
| `rigour_deep_stats` | Score history, trend analysis, and top issues from SQLite storage. |

### Supervisor & Execution

| Tool | Description |
|:---|:---|
| `rigour_run` | Executes a command under Rigour supervision with human arbitration. |
| `rigour_run_supervised` | Full supervisor mode — iterative command + gate check loop. |

### Settings

| Tool | Description |
|:---|:---|
| `rigour_mcp_get_settings` | Get MCP runtime settings (.rigour/mcp-settings.json). |
| `rigour_mcp_set_settings` | Set MCP runtime settings (e.g., deep_default_mode). |

### Multi-Agent Governance

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
      "args": ["-y", "@rigour-labs/mcp@5.3.2"],
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
