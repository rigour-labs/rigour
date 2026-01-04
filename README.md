
<div align="center">

```text
██████╗ ██╗ ██████╗  ██████╗ ██╗   ██╗██████╗ 
██╔══██╗██║██╔════╝ ██╔═══██╗██║   ██║██╔══██╗
██████╔╝██║██║  ███╗██║   ██║██║   ██║██████╔╝
██╔══██╗██║██║   ██║██║   ██║██║   ██║██╔══██╗
██║  ██║██║╚██████╔╝╚██████╔╝╚██████╔╝██║  ██║
╚═╝  ╚═╝╚═╝ ╚═════╝  ╚═════╝  ╚═════╝ ╚═╝  ╚═╝
```

### **Stop Vibe Coding. Start Engineering.**

[![NPM Version](https://img.shields.io/npm/v/@rigour-labs/core?style=for-the-badge&color=crimson)](https://www.npmjs.com/org/rigour-labs)
[![CI Status](https://img.shields.io/github/actions/workflow/status/erashu212/rigour/pipeline.yml?style=for-the-badge&label=Pipeline)](https://github.com/erashu212/rigour/actions)
[![License](https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

</div>

---

## 🛡️ What is Rigour?

**Rigour** is an open-source, local-first quality gate controller designed specifically for **AI Agentic Workflows**. 

Agents are powerful, but they are chaotic. They hallucinate, they leave `TODO`s, they ignore architectural rules, and they "vibe" their way to broken code. **Rigour forces them to behave.**

It injects a **stateless, deterministic feedback loop** into the agent's lifecycle, ensuring that no task is marked "Done" until it meets strict engineering standards.

### 🆚 Vibe Coding vs. Rigour Engineering

| Feature | 🚫 Typical AI Agent | 🛡️ Agent with Rigour |
| :--- | :--- | :--- |
| **Definition of Done** | "It looks like it works." | "It passes all static & dynamic gates." |
| **Code Quality** | Spaghetti, rapid prototyping style. | **SOLID**, **DRY**, Modular. |
| **Comments** | `// TODO: Fix this later` | **Forbidden**. Fix it now. |
| **Architecture** | Ignores project structure. | Adheres to `docs/ARCH.md`. |
| **Feedback** | User manually reviewing code. | **Automated Fix Packets** (JSON). |

---

## 🚀 Quick Start

Ensure your project is clean, then initialize Rigour.

```bash
# 1. Initialize Rigour in your project
npx @rigour-labs/cli init

# 2. That's it. Your agent now knows the rules.
```

### ⚡ The "Run Loop" (Recommended)

Don't just run Claude or Gemini. Run them **with Rigour**.

```bash
# Wraps the agent command in a self-healing quality loop
npx @rigour-labs/cli run -- claude "Refactor the auth middleware"
```

---

## 🏗️ Architecture

Rigour acts as the **Supervisor** between the Agent and the Filesystem.

```mermaid
sequenceDiagram
    participant User
    participant Agent
    participant Rigour
    participant Codebase

    User->>Agent: "Build this feature"
    loop Rigour Cycle
        Agent->>Codebase: Write Code
        Agent->>Rigour: Run specific checks?
        Rigour->>Codebase: Scan files
        Rigour->>Rigour: Verify Gates (Size, TODOs, Lint)
        alt Quality Check PASS
            Rigour-->>Agent: ✅ PASS
        else Quality Check FAIL
            Rigour-->>Agent: 🛑 FAIL (Violations Found)
            Rigour-->>Agent: 📋 Fix Packet (Prioritized Tasks)
            Agent->>Codebase: Refactor & Fix
        end
    end
    Agent->>User: "Task Verified & Complete"
```

---

## 🧩 Quality Gates

Rigour comes with built-in "Engineering Primitives" that you can configure in `rigour.yml`.

| Primitive | Description | Default Strictness |
| :--- | :--- | :--- |
| **Structure** | Enforces max file size (e.g., 300 lines). | **High** (SRP enforcement) |
| **Hygiene** | Bans `TODO`, `FIXME`, and leaked secrets. | **Total** (Zero tolerance) |
| **Determinism** | Runs `tsc`, `eslint`, or `vitest`. | **Configurable** |
| **Documentation** | Ensures critical docs exist. | **Medium** |

---

## 🤖 Agent Integration

Rigour integrates with all major AI coding tools via **CLI**, **MCP**, or **Agent Handshake**.

### 🖱️ Cursor & AntiGravity (Automatic Handshake)

Rigour writes a protocol file to `.cursor/rules/rigour.mdc` during `init`. The agent reads this and knows to run quality checks before claiming "Done".

```bash
npx @rigour-labs/cli init
# Creates .cursor/rules/rigour.mdc automatically
```

### 💻 Claude Code CLI

Use the `run` wrapper to create a self-healing loop:

```bash
npx @rigour-labs/cli run -- claude "Refactor the payment service"
```

### ♊ Gemini CLI

```bash
npx @rigour-labs/cli run -- gemini "Add error handling to the API layer"
```

### 🧠 Codex / OpenAI CLI

```bash
npx @rigour-labs/cli run -- codex "Implement the user authentication flow"
```

---

## 🔌 MCP Integration (Model Context Protocol)

For agents that support MCP (Claude Desktop, VS Code Cline, etc.), Rigour exposes tools directly.

### Claude Desktop

Add to your `claude_desktop_config.json`:

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

### VS Code Cline

Add to your Cline MCP settings:

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

### Available MCP Tools

| Tool | Description |
|:---|:---|
| `rigour_check_status` | Returns PASS/FAIL and a summary of all gate results. |
| `rigour_get_fix_packet` | Returns prioritized, actionable fix instructions for failures. |

The agent should call `rigour_check_status` before claiming task completion. If it fails, call `rigour_get_fix_packet` and iterate.

---

## 📜 License

MIT © [Rigour Labs](https://github.com/erashu212). 

> **"Software Engineering is what happens to programming when you add time and other programmers."** — Russ Cox. 
>
> Rigour adds the engineering.
