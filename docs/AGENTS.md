# Coding agents and MCP

Rigour reaches a coding agent in two ways. **Hooks** run Rigour's checks at fixed moments, whether or
not the agent asks: after an edit, before the agent says it is done, and before a push. The **MCP
server** gives the agent tools it can call itself: review the change, find an existing helper, recall
what the repository has learned. Hooks enforce; the MCP tools help the agent pass.

This page lists exactly what Rigour writes for each agent, the optional instruction file, every MCP
tool, and what to do when something does not fire. Setting Rigour up is covered in
[Get started](./QUICK_START.md) and [Team setup](./TEAM_SETUP.md); what each moment checks is in
[During development](./DEVELOPMENT.md).

## Which agents Rigour works with

| Agent | After every edit | Before "done" | Before push | Credential warnings (DLP) | MCP server written by setup |
| --- | --- | --- | --- | --- | --- |
| Claude Code | yes | yes | yes, in the agent and through git | yes, before every tool call | yes |
| Cursor | yes | yes | yes, through git | yes, before a prompt is sent | yes |
| Cline | yes | no | yes, through git | yes, before every tool call | no |
| Windsurf | yes | no | yes, through git | yes, before code is written | no |
| Codex, Gemini CLI, or you in a terminal | no | no | yes, through git | no | no |

"Through git" is git's own `pre-push` hook, which Rigour installs in the clone. It applies to every
tool and to a push from your terminal. Claude Code also checks a push before the command reaches git.

Every hook runs the CLI pinned to the version that wrote it: `npx --yes @rigour-labs/cli@<version>`.
Node 22.13 or later is required.

## Where the hooks go

| You run | Where the hooks are written | For which agents |
| --- | --- | --- |
| `rigour setup` (personal) | Each agent's user-level config, once per machine. Nothing in the working tree. | The agents installed on this machine: those with a `~/.claude`, `~/.cursor`, `~/.codeium/windsurf` or `~/Documents/Cline` folder. Claude Code when none is found. |
| `rigour setup --team` | The repository, to commit. | The agents the repository shows signs of (below). Claude Code when there are none. |
| `rigour hooks init --tool <name>` | The repository. | The one you name: `claude`, `cursor`, `cline`, `windsurf`, or `all`; several comma-separated. |

**Personal install.** The user-level files are `~/.claude/settings.json`, `~/.cursor/hooks.json`,
`~/.codeium/windsurf/hooks.json` and `~/Documents/Cline/Hooks/`. Each hook command is wrapped in a
guard: it looks for a `rigour-enabled` marker in the repository's git directory and exits 0 at once
when there is none. `rigour setup` writes that marker, so the hooks run only in repositories you have
switched on and stay silent everywhere else.

**Team install.** `rigour setup --team` looks for these signs in the repository root:

| Sign | Agent set up |
| --- | --- |
| `CLAUDE.md` or `.claude/` | Claude Code |
| `.cursor/` | Cursor |
| `.clinerules` | Cline |
| `.windsurfrules` or `.windsurf/` | Windsurf |

When none is present it falls back to the terminal it runs in (for example, `TERM_PROGRAM` naming
Cursor), and then to Claude Code. An `AGENTS.md`, `.gemini/` or `.vscode/` is recognised, but those
agents get no hooks. In a repository that already commits a `rigour.yml`, `rigour setup` writes the
hooks for the agents it detects (the same signs, plus `.cursorrules`), with the same options the team's
install used, so a teammate's setup changes no committed file.

**Adding an agent later.** `rigour hooks init --tool cursor` writes Cursor's hooks into the
repository. `--dry-run` lists the files without writing them. `--force` replaces a hook script Rigour
wrote earlier; a script of your own is never overwritten.

In every case a JSON config you already have is merged into: Rigour's earlier entries are swapped for
the new ones and everything else is kept. A file that is not valid JSON is left alone and named.
`rigour hooks init` also installs git's `pre-push` hook (below).

## Hooks for each agent

`<cli>` stands for `npx --yes @rigour-labs/cli@<version>`. In a personal install each command is
wrapped in the guard described above.

### Claude Code

File: `.claude/settings.json` (team) or `~/.claude/settings.json` (personal).

| Event | Matcher | Command | What it does |
| --- | --- | --- | --- |
| `PostToolUse` | `Write\|Edit\|MultiEdit` | `<cli> hooks check --stdin`, plus `--block` when asked | Fast checks on the file just written. |
| `Stop` | none | `<cli> hooks stop --tool claude` (timeout 120 s) | Reviews the branch against main before the agent finishes. At most three stops, then the agent may finish and the finding still blocks the push. |
| `PreToolUse` | `Bash` | `<cli> hooks push --stdin`, inside a shell that starts it only when the command mentions `git` and `push` (timeout 1800 s) | The push gate. A failure exits 2 and the agent is told each problem. `git push --dry-run` and every other command pass untouched. |
| `PreToolUse` | `.*` | `<cli> hooks check --mode dlp --stdin` | Credentials in the input of every tool call: a real secret's format denies the call, anything else is a warning the agent sees. |

### Cursor

File: `.cursor/hooks.json` (team) or `~/.cursor/hooks.json` (personal).

| Event | Command | What it does |
| --- | --- | --- |
| `afterFileEdit` | `<cli> hooks check --stdin`, plus `--block` when asked | Fast checks on the edited file. |
| `stop` (`loop_limit: 3`) | `<cli> hooks stop --tool cursor` | The branch review before the agent finishes. |
| `beforeSubmitPrompt` | `<cli> hooks check --mode dlp --stdin` | Credential warnings on the prompt you are about to send. |

Cursor has no push hook from Rigour; git's `pre-push` hook covers it.

### Cline

Files: `.clinerules/hooks/PostToolUse` and `.clinerules/hooks/PreToolUse` (team), or
`~/Documents/Cline/Hooks/PostToolUse` and `PreToolUse` (personal). Both are executable Node scripts.

| Hook | What it does |
| --- | --- |
| `PostToolUse` | For `write_to_file` and `replace_in_file` only: runs `<cli> hooks check --files <path>` with a 5-second limit and adds any finding to the agent's context. |
| `PreToolUse` | Sends the tool input's text values to `<cli> hooks check --mode dlp --stdin` with a 3-second limit and adds any warning to the agent's context. |

### Windsurf

File: `.windsurf/hooks.json` (team) or `~/.codeium/windsurf/hooks.json` (personal).

| Event | Command | What it does |
| --- | --- | --- |
| `post_write_code` | `<cli> hooks check --stdin`, plus `--block` when asked | Fast checks after Cascade writes a file. |
| `pre_write_code` | `<cli> hooks check --mode dlp --stdin` | Credential warnings on the hook input before code is written. |

### Codex, other agents, and the terminal

Rigour writes no hook or MCP config for Codex, Gemini CLI or VS Code. Their pushes, and yours, go
through git's `pre-push` hook.

### What `--block` changes

`--block` applies to the after-edit check. With it, a finding makes the check exit with code 2 (for
Cursor, it answers `continue: false`). Without it, the check reports the finding and exits 0.
`rigour setup` writes it, personal or team; `rigour hooks init` writes it only when you pass `--block`.
The stop and push hooks hold the agent regardless of this flag.

## Git's pre-push hook

Agent hooks only cover their agent. Git's `pre-push` hook covers every push from this clone.
`rigour setup` and `rigour hooks init` install it where git looks for hooks (`core.hooksPath`
included):

- No `pre-push` hook yet: Rigour writes one that runs `<cli> hooks push --git "$@"`.
- A `pre-push` hook another tool wrote: Rigour appends a comment and that one line, ending in
  `|| exit $?`.
- A hooks directory outside the repository, such as a machine-wide `core.hooksPath`: Rigour leaves it
  alone and prints the line to add yourself.
- A hooks directory committed in the repository, such as Husky's `.husky/`: a team install appends the
  line there, for you to commit; a personal install leaves it alone and prints the line, since a
  personal install changes nothing in the working tree.

The hook gates the commit git is about to send. It refuses a push while tracked files have
uncommitted changes, since it would otherwise check code the push does not carry. Deleting a remote
branch passes. A failure exits 1 and git does not push.

The hook lives in `.git/hooks`, which a clone does not carry, so each person runs `rigour setup` once
per clone. `rigour hooks selftest` proves the hook with a real push: in a scratch clone of a scratch
remote, a push with an export nothing uses must be refused and the fixed push must land, read from the
remote's refs.

## Credential warnings (DLP)

The DLP hooks look for credentials in what is about to reach the agent or a tool, so you can replace
them with a reference before they leave your machine. They are written with every agent's hooks.

| Agent | Hook | What is scanned |
| --- | --- | --- |
| Claude Code | `PreToolUse`, every tool | The tool call's input |
| Cursor | `beforeSubmitPrompt` | Your prompt |
| Cline | `PreToolUse` | The text values of the tool input |
| Windsurf | `pre_write_code` | The hook input before code is written |

It looks for cloud keys (AWS, GCP service accounts, Azure), provider API keys (OpenAI, Anthropic,
GitHub, Stripe, Twilio, Slack, SendGrid), private keys, database URLs with credentials, bearer tokens
and JWTs, password and `.env`-style assignments, credentials in URLs, CI and registry secrets, and
high-entropy encoded values.

For Claude Code, a credential in a real secret's format (a provider's own key format such as an AWS
access key or a Stripe live key, a private key, a GCP service account) **denies the tool call**: Claude
Code shows the agent the reason, and the credential is never written. Anything the scan only suspects
(a database URL with a password, a high-entropy value) is a warning added to the agent's context
beside the tool result. Before 6.13.0, a Claude Code payload was mistaken for Cursor's and nothing
was scanned; the hooks pin Rigour's version, so run `rigour setup` (or `rigour hooks init`) after
upgrading to move them to the new one.

For the other agents the DLP hooks **warn and never block**: the hook command carries no `--block`.
The hook prints the warning (for Cursor, as a message on the prompt; for Cline, in the agent's
context) and records it in `.rigour/events.jsonl`.

A warning that is wrong can be taught once:

```bash
rigour hooks check --dlp-allow-last
```

This stores a fingerprint of the value's shape (not the value) in `.rigour/dlp-feedback.json`.
Provider keys, private keys, tokens and high-entropy secrets are never learned away.

## Instructions

Instruction files are optional. The MCP tools describe themselves and the hooks enforce, so an agent
does not need to be told about Rigour for it to work.

`rigour setup --team --instructions` writes two files, each only where the repository has none:

- `AGENTS.md`, the file most coding agents read, containing the section below under an
  `# Agent instructions` heading.
- `CLAUDE.md`, one line: `@AGENTS.md`, so Claude Code reads the same file.

Where you already have them, Rigour keeps yours and prints what to add (`--force` replaces them). In a
repository that already commits a `rigour.yml`, `rigour setup --instructions` writes them the same way.
If you keep your own `AGENTS.md`, paste this section into it:

```markdown
## Rigour

This repository uses Rigour. Its hooks check your work after each edit, before you finish and before a push.

- Before you say a task is done, `rigour review --base origin/main` (or the `rigour_review` MCP tool) must show nothing to fix. Fix what it reports in your change.
- Before writing a new helper, ask `rigour_check_pattern` whether one already exists.
- Never edit `rigour.yml`, add an ignore, or dismiss a finding to make a check pass. Whether a finding is wrong is a person's call.
- Never push with `--no-verify`.
```

## The MCP server

### How it is registered

| Install | Claude Code | Cursor |
| --- | --- | --- |
| Personal (`rigour setup`) | `claude mcp add --scope user rigour -- <server>`. Needs the `claude` CLI on `PATH`; if it is missing, setup prints the command to run. A server already registered as `rigour` is left as it is. | Merged into `~/.cursor/mcp.json` under `mcpServers.rigour`, only when Cursor is installed. An existing `rigour` entry is left as it is. |
| Team (`rigour setup --team`) | `.mcp.json` at the repository root, under `mcpServers.rigour`. An existing `rigour` entry is kept. An `.mcp.json` that is not valid JSON is left alone. | `.cursor/mcp.json`, under `mcpServers.rigour`. An existing `rigour` entry is kept. A file that is not valid JSON is left alone. |

Setup writes no MCP config for Cline, Windsurf or Codex. The server speaks MCP over stdio, so any
client that starts stdio servers can be given the same command.

### What it runs

`<server>` is:

```bash
npx -y @rigour-labs/mcp@<major>
```

`<major>` is the major version of the CLI that wrote it. Fixes arrive without editing the config; a
breaking major release does not. When the CLI runs from a source checkout, the config points at that
checkout's `packages/rigour-mcp/dist/index.js` with `node` instead. `rigour uninstall --machine`
removes the user-level registrations.

### Which repository it serves

Each tool call works in the repository given by the call's own `cwd` argument, else `RIGOUR_CWD`,
else the directory the server started in. Set `RIGOUR_CWD` in the server's `env` when your client
starts servers somewhere other than the repository.

### The tools it lists

Each listed tool costs every agent session its definition in context, so by default the server lists
only the core tools. Set `RIGOUR_MCP_TOOLS` in the server's `env` to list more: a comma-separated list
of groups (`governance`, `context`, `telemetry`), or `full` for all of them. Unknown names are
ignored. A repository whose `rigour.yml` sets `gates.agent_team.enabled` or `gates.checkpoint.enabled`
to `true` gets the governance group without asking. A tool that is not listed can still be called by
name.

```json
{
  "mcpServers": {
    "rigour": {
      "command": "npx",
      "args": ["-y", "@rigour-labs/mcp@<major>"],
      "env": { "RIGOUR_MCP_TOOLS": "governance" }
    }
  }
}
```

**Listed by default**

| Purpose | Tool | What it is for |
| --- | --- | --- |
| Review | `rigour_review` | Review the change before calling it done: uncommitted work, or the whole branch with `base`. Only findings on changed lines, each with file, line and a fix. With `mode: "agent"` it also returns the risky changed functions and what to check in each, for the agent to review with its own model. |
| Review | `rigour_review_ack` | Record the agent's verdict on one of those functions (`fixed` or `no_issue`, with a note). It holds until the function's code changes. |
| Review | `rigour_reviewer_verdict` | Read what the model [reviewer](./REVIEWER.md) last decided for the branch: items to fix, disputed items, and whether the verdict is for the current commit. Read-only. |
| Review | `rigour_check` | With no files: the agent's change, judged as the stop hook and push gate judge it (fail means something to fix in the change). With files: those files. |
| Review | `rigour_get_fix_packet` | After a failed `rigour_check`: the change's must-fix items, then its notes, a page at a time (5 by default, at most 10), each with `file:line` and the fix. See [Fix packet](./FIX_PACKET.md). |
| Reuse and context | `rigour_index` | Build or update the pattern index (`.rigour/patterns.json`): functions, classes, routes and signatures, embedded locally so they can be found by intent. |
| Reuse and context | `rigour_context_scope` | Before reading source files: a small edit scope (3 to 10 files) with signatures, for a plain-language description of the task. |
| Reuse and context | `rigour_check_pattern` | Before writing a new function, component, hook or class: whether one already exists (by name, intent or signature), and known vulnerabilities. Refuses writes to protected paths such as `.github/` and `rigour.yml`. |
| Before writing | `rigour_brief` | Once at the start of a task: the team's rules, verified lessons and settled points for the files it will touch, at most 10, each cited. See [The briefing](./BRIEF.md). |
| Memory and lessons | `rigour_recall` | At the start of a task: the stored conventions and lessons that match it by meaning, plus promoted team knowledge when a team is configured. |
| Memory and lessons | `rigour_remember` | Store a convention for later sessions, for this repository, for all your repositories, or as a team candidate a person can promote. Values containing credentials are refused. |

**Governance group** (`RIGOUR_MCP_TOOLS=governance`, or turned on by `rigour.yml`)

| Tool | What it is for |
| --- | --- |
| `rigour_agent_register` | Claim a task scope (file globs) in a session with several agents, so conflicts between agents are detected. |
| `rigour_agent_deregister` | Release that scope when the agent is done. |
| `rigour_checkpoint` | Record progress, changed files, a summary and a self-assessed quality score during long work; refreshes the pattern index for the changed files. |
| `rigour_handoff` | Hand a task to another agent, with the files in scope and context. |
| `rigour_handoff_accept` | Accept a handoff; only the named recipient can. |
| `rigour_hooks_check` | Run the after-edit checks on given files, or the DLP scan on given text. |
| `rigour_hooks_init` | Write an agent's hook config, as `rigour hooks init` does; `dlp: false` leaves out the DLP hooks. |
| `rigour_run` | Run a command after a command firewall check and a person's approval in Studio. With no answer within 60 seconds it is denied. |
| `rigour_run_supervised` | Run an agent command, check the result, and return fix packets until the checks pass or the retry limit (default 3) is reached. |

**Other groups**

| Group | Tool | What it is for |
| --- | --- | --- |
| `context` | `rigour_explain` | Why the checks failed, in plain language. |
| `context` | `rigour_forget` | Remove a stored memory by key. |
| `context` | `rigour_context_explain` | Why files were included in or left out of a context scope, and the cache state. |
| `context` | `rigour_security_audit` | Check the project's dependencies for known vulnerabilities. |
| `telemetry` | `rigour_context_stats` | How much context the scoped reads returned against what was available. |
| `telemetry` | `rigour_task_cost` | Rigour's estimate of the context and cost its scoped reads avoided for a task. |
| `telemetry` | `rigour_cache_stats` | Hit and miss counts across Rigour's cache layers. |

The server also answers a few tools that no group lists, for scripts and dashboards:
`rigour_status`, `rigour_list_gates`, `rigour_get_config`, `rigour_mcp_get_settings`,
`rigour_mcp_set_settings`, `rigour_check_deep` and `rigour_deep_stats`.

## Several organizations on one machine

A profile keeps each organization's memory, lessons, settings and team apart, chosen by repository; the
MCP server refuses a call for a repository of another profile. See [Profiles](./PROFILES.md).

## Troubleshooting

### Start with `rigour doctor`

```bash
rigour doctor
```

For this repository it reports, each as working (fired in the last seven days), set up (configured but
not seen firing), broken, or missing, with the command that fixes it:

- the project settings (`rigour.yml`, or a personal install's defaults);
- the after-edit hook for Claude Code, Cursor and Windsurf, in the project and, for a personal
  install, at user level. It names the old hook that passes a variable the agent never sets, so no
  edit is checked (fix: `rigour setup`, which rewrites Rigour's own entries in the project or, for a
  personal install, at user level). Cline's hooks are not checked;
- the stop hook;
- the MCP server, found in `.mcp.json`, `~/.claude.json` or `~/.cursor/mcp.json`, or seen through tool
  calls;
- the pull request workflow;
- settings an older Rigour wrote that no longer do what they say:
  - a `rigour.yml` made from a preset that blocks on every security finding (healthcare, fintech,
    government, devsecops) before `gates.security.block` existed: its security findings are shown as
    notes. `rigour setup` adds `block: true`, keeping the file's comments;
  - `gates.deprecated_apis.block_security_deprecated: true`, which older `rigour init` wrote for
    everyone: keep it if your team chose it, otherwise delete the line. Rigour never changes it.

The old edit hook also says so itself: on every edit it prints that it checks nothing and to run
`rigour setup`, and exits 1, which the agent shows you without stopping the edit.

When the clone has Rigour's `pre-push` hook, doctor also runs the same real-push test as
`rigour hooks selftest`.

### A hook does not fire

- **Personal install, wrong repository.** The hooks stay silent in a repository you have not switched
  on. Run `rigour setup` in it. The marker is `rigour-enabled` in the directory
  `git rev-parse --git-common-dir` prints.
- **The agent has not reloaded.** Reload the Cursor window (its Output panel has a Hooks log) or the
  Windsurf editor after the hooks are written.
- **The agent was not set up.** Setup writes hooks only for the agents it found. Add one with
  `rigour hooks init --tool <name>`.
- **A config was skipped.** Setup prints `SKIP` (or "Left alone") for a config that is not valid JSON.
  Fix the JSON and run setup again.
- **The push went through.** The agent's push hook acts only on commands that contain `git` and
  `push`. Check that the clone has the git hook (`rigour doctor`); if your hooks directory is outside
  the repository, or a personal install found it committed in the repository, add the line setup
  printed to your own `pre-push` hook.
- **The first run is slow.** Every hook runs the pinned CLI through `npx`, which downloads it on first
  use. Cline's after-edit script gives the check 5 seconds.

### The MCP server is not listed

- **Claude Code, personal install.** `claude mcp get rigour` shows whether it is registered. If setup
  printed a `claude mcp add` command because the `claude` CLI was not found, run that command.
- **Claude Code, team install.** The server is in `.mcp.json` at the repository root, under
  `mcpServers.rigour`. Setup leaves an `.mcp.json` that is not valid JSON untouched and says so.
- **Cursor.** Look for `mcpServers.rigour` in `.cursor/mcp.json` or `~/.cursor/mcp.json`.
- **The server is listed but a tool is not.** Only the core tools are listed by default; set
  `RIGOUR_MCP_TOOLS` as shown above.
- **Calls are refused for this repository.** The server applies the profile of the repository it
  serves and refuses calls for another profile's repositories. Set `RIGOUR_CWD`, or see
  [Profiles](./PROFILES.md).
- **The server does not start.** It needs Node 22.13 or later.
