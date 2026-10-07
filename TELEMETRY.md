# Telemetry

Rigour can send anonymous usage data, **only if you say yes**. It tells us which commands people use, how reviews end, and above all which checks get dismissed as "not a bug", so the next release fixes what actually gets in your way.

## Your choice

- `rigour init` asks once, at a terminal. CI is never asked and never sends.
- `rigour telemetry on`, `rigour telemetry off`, `rigour telemetry status`.
- `DO_NOT_TRACK=1` or `RIGOUR_TELEMETRY=0` turns it off whatever you chose. `RIGOUR_TELEMETRY=1` turns it on (for CI you want measured).
- Builds from source and forks have no telemetry token and never send anything.

## Never sent

Code, file names, paths, repository names, git remotes, branch names, finding messages, emails, API keys, environment variables, or your IP address (events go to Mixpanel with `ip=0`).

## Sent

Every event carries: a random install id (`~/.rigour/telemetry.json`, not tied to you, your machine or a repository), the Rigour version, the OS (`darwin`, `linux`, `win32`), the Node major version, and whether it ran in CI.

| Event | When | Fields |
| --- | --- | --- |
| `command_run` | A CLI command finishes (not agent hooks) | `command` (e.g. `review`, `learn`), `outcome` (`ok`/`fail`), `duration` (bucket: `<1s` … `>2m`) |
| `review_completed` | `rigour review` finishes | `status`, `surface` (`terminal`/`json`/`ci`/`github`), `changed_files` (count), `findings_by_gate`, `advisory_by_gate`, `dismissed_by_gate` (counts per check name), `context_findings` (count), `deep_tier`, `deep_routed`, `deep_tool_calls` (counts), `deep_cost_bucket`, `duration` (bucket) |
| `reviewer_completed` | The model reviewer finishes, or ends without a verdict | `outcome`, `trigger` (`push`/`review`/`backtest`), `scope` (`full`/`delta`), `asked` and `ran` (`single`/`cross`/`full`/`panel`), `source` (`flag`/`env`/`user`/`team`), `degraded` (yes/no), `escalation` (`one-judge`/`all-judges`), `refused`, `judges`, `confirmed`, `disputed`, `dropped`, `notes`, `dismissed`, `runs` (counts), `cached` (yes/no), `cost_bucket` |
| `daily_usage` | Once a day, the totals of agent activity counted locally | `hook_check`, `hook_finding:<check>`, `stop_review`, `stop_block`, `stop_block_repeat`, `mcp:<tool>`, `mcp_error:<tool>` (counts) |

Agent hooks and MCP tools run on every edit, so they are only counted on your machine (`~/.rigour/telemetry-counters.json`, no network) and sent as one `daily_usage` event a day. A send that fails or takes more than two seconds is dropped; telemetry never slows or fails a command.
