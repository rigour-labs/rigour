# Telemetry

Rigour can send anonymous usage data, and only if you say yes. It shows which commands people run, how reviews end, and which checks get dismissed as "not a bug", so the next release fixes what gets in your way. Nothing is sent until you opt in, and a published build is the only kind that can send at all.

## Your choice

### When Rigour asks

Rigour asks once, at a terminal, at the end of `rigour init`. `rigour setup --team` runs `rigour init` when the repository has no `rigour.yml` yet, so it asks there too. A personal `rigour setup`, and `rigour setup --team` in a repository that already has a `rigour.yml`, do not ask.

The question is skipped, and nothing is recorded, when:

- stdin or stdout is not a terminal;
- a CI variable is set (`CI`, `GITHUB_ACTIONS`, `BUILDKITE`, `GITLAB_CI`, `CIRCLECI`, `JENKINS_URL`, `TF_BUILD` or `TEAMCITY_VERSION`);
- `RIGOUR_TELEMETRY` is set to any value;
- `DO_NOT_TRACK` is set to anything other than `0`;
- the build has no telemetry token;
- you already answered.

The default answer is no. Only `y` or `yes` turns it on.

### Changing it

```bash
rigour telemetry status   # on or off, and why (also the default with no argument)
rigour telemetry on
rigour telemetry off
```

The answer is stored in `telemetry.json` in Rigour's home: `~/.rigour/telemetry.json`, or `$RIGOUR_HOME/.rigour/telemetry.json` when `RIGOUR_HOME` is set. A profile sets `RIGOUR_HOME`, so each profile keeps its own answer and its own install id (see [Several organizations on one machine](docs/PROFILES.md)).

### Environment variables

| Variable | Effect |
| --- | --- |
| `DO_NOT_TRACK` set to any value except `0` | Off, whatever you chose |
| `RIGOUR_TELEMETRY=0` | Off, whatever you chose |
| `RIGOUR_TELEMETRY=1` | On without asking, in CI too. Use it for a CI job you want measured |
| `RIGOUR_MIXPANEL_TOKEN` | The Mixpanel project token to send with, in place of the one built into the release |

Any other value of `RIGOUR_TELEMETRY` does nothing: your stored answer applies. In CI, telemetry is off unless `RIGOUR_TELEMETRY=1`.

### Builds without a token

The token is empty in the source and written in by the release workflow before the published package is built. A build from source or a fork has no token and sends nothing, unless `RIGOUR_MIXPANEL_TOKEN` is set.

## Never sent

Code, file names, paths, repository names, git remotes, branch names, finding messages, emails, API keys or environment variables. Events go to `https://api.mixpanel.com/track?ip=0`; `ip=0` tells Mixpanel not to record the IP address the request comes from.

## Sent

### On every event

| Property | Value |
| --- | --- |
| `distinct_id` | A random install id (a UUID in `telemetry.json`), not derived from you, your machine or a repository |
| `time` | The time of the event, in seconds |
| `$insert_id` | A random id per event |
| `token` | The Mixpanel project token |
| `os` | `darwin`, `linux` or `win32` |
| `node_major` | The Node.js major version |
| `ci` | Whether a CI variable was set |
| `version` | The Rigour CLI version, on events sent by the CLI command itself (`command_run`, `review_completed`, and `daily_usage` sent after a command). `reviewer_completed` and the `daily_usage` sent by `rigour review` or the MCP server do not carry it |

### Events

| Event | When | Properties |
| --- | --- | --- |
| `command_run` | A CLI command finishes. Not sent for `rigour hooks ...` or `rigour telemetry` | `command` (the command's name, for example `review` or `learn`), `outcome` (`ok` or `fail`), `duration` (a bucket) |
| `review_completed` | `rigour review` finishes | `status`; `surface` (`terminal`, `json`, `ci` or `github`); `changed_files` (count); `findings_by_gate`, `advisory_by_gate`, `dismissed_by_gate` (counts keyed by check id); `context_findings` (count); `deep_tier` (`none` without a model); `deep_routed`, `deep_tool_calls` (counts); `deep_cost_bucket`; `duration` (a bucket) |
| `reviewer_completed` | The reviewer finishes, or ends without a verdict | `outcome` (`passed`, `findings`, `unavailable` or `skipped`); `trigger` (`push`, `review` or `backtest`); `scope` (`full` or `delta`); `asked` (`single`, `cross`, `full`, `panel` or `orchestrator`) and `ran` (the same, or `none` when no judge ran); `source` (`flag`, `env`, `user` or `team`); `degraded` (true or false); `escalation` (`one-judge` or `all-judges`); `refused`, `judges`, `confirmed`, `disputed`, `dropped`, `notes`, `dismissed`, `runs` (counts); `cached` (true or false); `cache` (`content` when the verdict was reused for the same content on another commit); `cost_bucket`. With the orchestrator: `parts` and `passes` (counts), `split`, `fallback` and `nothing_to_review` (true or false), `beyond_slice` (passes that read outside their slice, a count) |
| `daily_usage` | At most once a day: the agent activity counted on your machine since the last one | One count per name that occurred: `hook_check`, `hook_finding:<check id>`, `stop_review`, `stop_block`, `stop_block_repeat`, `mcp:<tool>`, `mcp_error:<tool>` |

Buckets:

| Bucket | Values |
| --- | --- |
| `duration` | `<1s`, `1-5s`, `5-30s`, `30s-2m`, `>2m` |
| `deep_cost_bucket`, `cost_bucket` | `<$0.10`, `$0.10-0.50`, `$0.50-2`, `>$2` |

A property with no value is left out of the event.

### Hooks and MCP tools are counted locally

Agent hooks and MCP tools run on every edit, so they never send an event themselves. While telemetry is on they add to counters in `telemetry-counters.json` in Rigour's home, with no network call. Once the counters are a day old, the next CLI command (other than `rigour hooks ...` and `rigour telemetry`), `rigour review`, or MCP server start sends them as one `daily_usage` event and starts a new day.

## Delivery

An event is one HTTPS POST with a two-second timeout. A send that fails or times out is dropped and not retried; telemetry never fails or slows a command beyond that timeout.

See [Security, privacy and network use](docs/SECURITY.md) for every other network call Rigour makes.
