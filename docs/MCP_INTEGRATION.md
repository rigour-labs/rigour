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
- **`rigour_context_scope`**: Returns the smallest evidence-backed file scope plus applicable patterns and validated learning.
- **`rigour_check_pattern`**: Advises whether to reuse an existing pattern, replace a stale approach, or stop for a security or protected-path issue.
- **`rigour_recall`**: Recalls retained project memory after DLP filtering.

### Guidance and impact metadata

Context, pattern, and recall responses include a structured `_meta.rigourImpact` object for MCP clients. It records the recommendation, supporting pattern/lesson/memory references, selected scope, cache state, and measured token estimate. Studio persists the same safe metadata as an Advice node and aggregates it into the agent run's Impact Receipt. Memory values and source code are not duplicated into this metadata.

An impact receipt proves what Rigour returned; it does not claim that the agent followed the advice or that Rigour caused the final outcome. Dollar savings remain separate until the actual model and applicable pricing are observed.

### MCP Gateway: observe first, then enforce

The normal `rigour` MCP server gives agents engineering context and verification tools. The optional gateway is different: it launches selected downstream MCP servers and becomes the mediated route to their tools.

Create a JSON configuration outside the repository:

```json
{
  "version": 1,
  "mode": "observe",
  "principalId": "team-owner",
  "agentId": "cursor-agent",
  "taskId": "ENG-42",
  "servers": {
    "github": {
      "command": "/absolute/path/to/github-mcp-server",
      "args": ["stdio"],
      "allow": ["get_issue", "create_issue"]
    }
  }
}
```

Install it into Rigour's user-level control directory:

```bash
rigour firewall gateway-configure --config ~/rigour-gateway.json
```

Configure the agent host with an absolute repository path:

```json
{
  "mcpServers": {
    "rigour-gateway": {
      "command": "npx",
      "args": [
        "-y",
        "@rigour-labs/mcp@latest",
        "--gateway",
        "--repo",
        "/absolute/path/to/repository"
      ]
    }
  }
}
```

Downstream tools are exposed as `<server>__<tool>`, for example `github__create_issue`. In `observe` mode the call proceeds, while its receipt records whether explicit authority would have been required. After reviewing `rigour firewall receipts`, change the configuration to `"mode": "enforce"`, reinstall it, and issue a one-use capability for each protected call:

```bash
rigour firewall grant \
  --agent cursor-agent \
  --task ENG-42 \
  --tool github__create_issue \
  --ttl 300
```

The agent passes the returned id as `_rigourCapability` in that tool call. Capabilities bind subject, task, action, resource, expiry, and policy hash. Delegated capabilities additionally use `--issuer` and `--parent`; creating a child consumes its parent, and the child cannot change the parent's task, action, resource, or expiry bound.

The installed configuration binds one `agentId` and `taskId`. Install a distinct configuration when that trusted execution identity changes. A server may also define an `env` string map; because those values are copied into the protected control directory, create the source file outside the repository and never commit credentials.

Trusted state and the signed receipt chain live under `~/.rigour/control/<repository-id>`. `.rigour/execution-receipts.jsonl` is only a Studio projection and is never trusted for authorization.

#### Security boundary

The gateway controls only calls routed through it. If the same downstream MCP server is also configured directly in the agent host, the agent can bypass Rigour. Remove direct routes—or enforce the host configuration administratively—before describing the setup as enforced. The 6.2 gateway covers MCP stdio calls; universal shell, browser, and cloud API interception are not claimed.

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
