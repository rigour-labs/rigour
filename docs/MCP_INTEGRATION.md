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
      "args": ["-y", "@rigour-labs/mcp@latest"]
    }
  }
}
```

### Available Tools

Every advertised tool costs each agent session its definition in context, so by default Rigour lists the **core** loop only, about 2,100 tokens of definitions instead of about 5,000 for everything.

| Group | Tools | When |
|:---|:---|:---|
| **core** (default) | `rigour_recall`, `rigour_index`, `rigour_context_scope`, `rigour_check_pattern`, `rigour_check`, `rigour_review`, `rigour_get_fix_packet`, `rigour_remember` | Every session |
| governance | `rigour_agent_register`, `rigour_agent_deregister`, `rigour_checkpoint`, `rigour_handoff`, `rigour_handoff_accept`, `rigour_hooks_check`, `rigour_hooks_init`, `rigour_run`, `rigour_run_supervised` | Multi-agent teams, hooks, supervised loops |
| context | `rigour_explain`, `rigour_forget`, `rigour_context_explain`, `rigour_security_audit` | Occasionally |
| telemetry | `rigour_context_stats`, `rigour_task_cost`, `rigour_cache_stats` | Dashboards |

Add groups with `RIGOUR_MCP_TOOLS` in the server's environment (`"governance,telemetry"`, or `"full"` for everything):

```json
{
  "mcpServers": {
    "rigour": {
      "command": "npx",
      "args": ["-y", "@rigour-labs/mcp@latest"],
      "env": { "RIGOUR_MCP_TOOLS": "governance" }
    }
  }
}
```

Key tools:
- **`rigour_review`**: reviews the change the agent just made. With no arguments it reads uncommitted work from git, new files included; `base: "main"` reviews the whole branch. It returns findings on changed lines only, each with file, line and a suggested fix. This is the same engine and verdict as `rigour review` in CI.
- **`rigour_check`**: runs the quality gates on the repository (same as `rigour check`).
- **`rigour_get_fix_packet`**: a bounded, severity-ordered view of Fix Packet v3. Start with `offset=0` and follow the returned offset.
- **`rigour_context_scope`**: the smallest evidence-backed file scope, plus the patterns and validated learning that apply.
- **`rigour_check_pattern`**: whether to reuse an existing pattern, replace a stale approach, or stop for a security or protected-path issue.
- **`rigour_recall`** / **`rigour_remember`**: memory in three scopes: `repo` (this repository), `user` (all your repositories) and `team` (shared as a candidate; teammates' agents receive it once a person promotes it). `rigour_recall` with `query` returns the few memories that match by meaning, plus promoted team knowledge when team mode is on. Credentials are refused on store and withheld on recall.

Server environment:
- `RIGOUR_CWD`: the repository a call works in when the call does not name one (tools and prompts alike); otherwise the directory the server was started in.
- `RIGOUR_USER_MEMORY=off`: the server never reads or writes `user` memory (`~/.rigour/memory.json`); `rigour_remember` with `scope: "user"` is refused. Set it on a server that must stay apart from your other work, such as one per employer or client.
- Profiles (`~/.rigour/profiles.json`, see [Profiles](PROFILES.md)) choose the home and team by repository. A server applies the profile of the repository it serves when it starts, and refuses a call for a repository of another profile, so even a single server registered globally (for example by a desktop app, which can reach every session) never answers one organization's call with another's memory or team.

A repository without `rigour.yml` uses Rigour's defaults. Tool calls never write configuration into the repository; run `npx rigour init` for that.

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

### Pro-Tip: The "Review Before Done" Pattern

Instruct your agent to call `rigour_review` before it claims a task is complete. If it returns `FAIL`, the agent fixes each finding at its `file:line`, following the suggestion, and calls `rigour_review` again until it passes. `rigour init` writes this step into AGENTS.md.

---

## 3. The `run` Loop (Best for CLI Agents)
...

For agents that run in the terminal (like **Claude Code**), use the `run` wrapper for a self-healing automation loop.

```bash
npx @rigour-labs/cli run -- <agent-cli-command>
```

Rigour will intercept the agent's work, run checks, and feed failure metadata back into the agent's next turn until the code is perfect.
