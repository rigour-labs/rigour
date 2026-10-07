# @rigour-labs/mcp

[![npm version](https://img.shields.io/npm/v/@rigour-labs/mcp?color=4f46e5)](https://www.npmjs.com/package/@rigour-labs/mcp)

Rigour's MCP server. It gives a coding agent tools to review its own change before it says it is done, to
check for an existing helper before writing a new one, and to recall what the repository and the team have
learned. It runs on your machine over stdio and works with Claude Code, Cursor and other MCP clients.

## Set it up

`rigour setup` (from [@rigour-labs/cli](https://www.npmjs.com/package/@rigour-labs/cli)) registers it for
Claude Code and Cursor, together with the hooks that run Rigour's checks whether or not the agent asks. To
register it by hand:

```bash
claude mcp add --scope user rigour -- npx -y @rigour-labs/mcp@6
```

Or, in any client's MCP configuration:

```json
{ "mcpServers": { "rigour": { "command": "npx", "args": ["-y", "@rigour-labs/mcp@6"] } } }
```

Node 22.13 or later. Each call works in the repository given by its `cwd` argument, else `RIGOUR_CWD`, else
the directory the server started in.

## The tools

| Tool | What it is for |
| --- | --- |
| `rigour_review` | Review the change before calling it done: only findings on changed lines, each with a fix |
| `rigour_review_ack` | Record the agent's verdict on a risky changed function |
| `rigour_reviewer_verdict` | What the reviewer last decided for the branch (read-only) |
| `rigour_check`, `rigour_get_fix_packet` | Run the checks, and get the violations a page at a time |
| `rigour_index`, `rigour_context_scope`, `rigour_check_pattern` | Find the few files a task needs, and whether a helper already exists |
| `rigour_recall`, `rigour_remember` | Recall and store conventions and lessons |

More groups (agent teams, context, telemetry) are listed with `RIGOUR_MCP_TOOLS`. Every tool:
[Coding agents and MCP](https://github.com/rigour-labs/rigour/blob/main/docs/AGENTS.md).

MIT © [Rigour Labs](https://github.com/rigour-labs)
