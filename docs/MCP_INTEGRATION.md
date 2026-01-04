# 🤖 AI Agent Integration

Rigour is designed to be the "governor" for AI agents. It works with all major agentic tools.

## 1. The Universal Handshake

When you run `rigour init`, it creates:
- `.cursor/rules/rigour.mdc`: Global instructions for the **Cursor** IDE.
- `docs/AGENT_INSTRUCTIONS.md`: A universal markdown guide that any agent (Claude, Gemini, ChatGPT) can read upon entry.

These files tell the agent that:
- Engineering excellence is mandatory.
- Code must pass `rigour check` before being submitted.
- High-fidelity `rigour-fix-packet.json` files contain diagnostic data on failure.

## 2. Model Context Protocol (MCP)

Rigour exposes an MCP server for agents that support the protocol (Claude Desktop, VS Code Cline, Cursor).

### 🚦 The Two Modes of Operation

It is critical to understand how Rigour integrates with your workflow:

| Mode | Role | Best For |
|:---|:---|:---|
| **MCP Mode** | **Pre-flight Validator**. The agent uses these tools to verify code quality *before* finalizing its work. | Cursor, Cline, Desktop agents. |
| **CLI Run Mode** | **Supervised Loop**. Rigour executes the agent and automatically feeds back failures in a self-healing loop. | Claude Code, Terminal-based agents. |

---

### Configuration

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

### Available Tools

- **`rigour_status`**: Quick PASS/FAIL check with JSON output. Best for polling.
- **`rigour_check`**: Run quality gate checks (same as CLI `check`).
- **`rigour_explain`**: Get actionable bullets for failures (same as CLI `explain`).
- **`rigour_get_fix_packet`**: The authoritative source of truth for what needs to be fixed (JSON Fix Packet v2).
- **`rigour_list_gates`**: List which gates (ast, hygiene, file_size) are active and their thresholds.
- **`rigour_get_config`**: Returns the full `rigour.yml` for agent reasoning about project constraints.

---

### Pro-Tip: The "Audit Before Done" Pattern

Instruct your agent to always run `rigour_status` before it claims a task is complete. If it returns `FAIL`, the agent MUST calls `rigour_explain` or `rigour_get_fix_packet` to resolve the debt.

---

## 3. The `run` Loop (Best for CLI Agents)
...

For agents that run in the terminal (like **Claude Code**), use the `run` wrapper for a self-healing automation loop.

```bash
npx @rigour-labs/cli run -- <agent-cli-command>
```

Rigour will intercept the agent's work, run checks, and feed failure metadata back into the agent's next turn until the code is perfect.
