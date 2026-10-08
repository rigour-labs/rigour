# Security, privacy and network use

This page is for the person who approves Rigour. It lists every network connection Rigour can make, what it stores on disk and where, what it writes into a repository, and what it runs on your machine. Everything here is read from the source; where Rigour hands work to another program (npm, git, gh, an agent CLI, a model SDK), the page says so and stops there.

## The short version

- Rigour's checks run locally. Apart from the update check and the one-time downloads listed below, a plain `rigour check`, `rigour review` or an agent hook reads your files and git history and makes no network call.
- Every network call is either something you asked for (a model review, a team database, posting on a pull request), a download Rigour needs once (the semantic search library, a local model), or one of two background calls you can switch off: the update check and opt-in telemetry.
- API keys and the team database URL are stored in plain JSON in Rigour's home, readable only by your user (file mode `0600`). Environment variables work instead of stored values.
- Code leaves the machine only when you enable a model: a cloud provider you chose with a key, or the agent CLIs you already use when the reviewer is on.

## Every outbound connection

Rigour's home is `~/.rigour`, or `$RIGOUR_HOME/.rigour` when `RIGOUR_HOME` is set (a profile sets it; see [Several organizations on one machine](./PROFILES.md)). Paths below use `~/.rigour` for short.

### Model review

| Destination | When | What is sent | How to turn it off |
| --- | --- | --- | --- |
| A cloud model provider: `api.anthropic.com` (through the Anthropic SDK), `api.openai.com`, `generativelanguage.googleapis.com`, `api.groq.com`, `api.mistral.ai`, `api.together.xyz`, `api.fireworks.ai`, `api.deepseek.com`, `api.perplexity.ai`, `openrouter.ai`, or the URL you give with `--api-base-url` | `rigour check`, `rigour scan` or `rigour review` with `--deep`, `--pro`, `--max` or `-k`, when a key is found (`-k`, then `RIGOUR_API_KEY`, then `rigour settings set-key`); or an agent calling the deep MCP tool with a key | Your API key, and prompts built from the changed code. In a review the model may also call two read-only tools, `read_file` (at most 200 lines a call) and `grep`, inside the repository. Files that look like secrets (`.env*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_*`, `.npmrc`, `.netrc`, `credentials`, `credentials.json`) are never read for the model | Do not pass those flags. Without one of them no model runs |
| Ollama at `http://localhost:11434/v1` or LM Studio at `http://localhost:1234/v1` | As above, with `--provider ollama` or `--provider lmstudio`. No key is needed | The same prompts, to your own machine | As above |
| `huggingface.co`, file `datasets/rigour-labs/rigour-rlaif-data/resolve/main/latest_version.json` | Only while a local model is being downloaded (`--deep` with no key, or `rigour deep pull`), at most once a day | A plain GET | Stage the model ahead of time (see the air-gapped section) |
| `huggingface.co`, the model file (`rigour-labs/rigour-<tier>-v<version>-gguf`, or the stock `Qwen/Qwen2.5-Coder-*-Instruct-GGUF` if the fine-tuned one cannot be fetched) | The first local model run for a tier, or `rigour deep pull`. A cached model is used without any network call | A GET. When Hugging Face's ETag carries the file's SHA-256, the download must match it or it is deleted | `--model-path <file.gguf>` uses a file you supply |
| `github.com/ggml-org/llama.cpp/releases/download/b5604/...` | The first local model run, when no working `llama-cli` is installed. Rigour looks in `~/.rigour/bin` and on `PATH` first | A GET. The archive must match a SHA-256 pinned in Rigour's source, or it is refused | Install `llama-cli` yourself, or run `rigour deep pull` on a connected machine and copy `~/.rigour/bin` |

Note for proxies: `--api-base-url` sends every provider's calls, Anthropic's included, to the URL you give.

### The reviewer (your agent CLIs)

The reviewer is off by default (`review.reviewer.enabled: false` in `rigour.yml`). When a team or a person turns it on, Rigour runs the coding-agent CLIs already installed on the machine: `claude`, `cursor-agent` or `codex`. Each CLI talks to its own vendor with its own login; Rigour gives it no key.

| Destination | When | What is sent | How to turn it off |
| --- | --- | --- | --- |
| The vendor of each agent CLI that runs (Anthropic for `claude`, Cursor for `cursor-agent`, OpenAI for `codex`) | `rigour review --reviewer`, `rigour backtest --reviewer`, `rigour learn-reviews --rules` (the review points only), or at push when the reviewer is enabled. At push a model is asked only when the branch has an open, non-draft pull request | A prompt with the branch's change and its review context, plus what the CLI reads with its read-only tools | Leave `review.reviewer.enabled` off, or set `reviewer.enabled: false` in your own settings (a team that requires the reviewer can refuse this) |
| GitHub, through `gh` (`gh pr view`, `gh api .../pulls/<n>/reviews`, `.../comments`, `.../commits/<sha>/pulls`; in a backtest, `gh api graphql` for the description's edit history) | Whenever the reviewer runs, to find the pull request and read people's reviews (except a backtest round that names no pull request, which is reviewed blind); `rigour review --scope`; `rigour backtest init --pr <n>` | Read-only API requests with the token `gh` holds (or the token of the account named by `review.github_account` / `RIGOUR_GITHUB_ACCOUNT`, read with `gh auth token --user`) | Do not run those commands; keep the reviewer off |

How each CLI is run:

| CLI | Arguments Rigour passes | Effect |
| --- | --- | --- |
| `claude` | `-p <prompt> --output-format stream-json --verbose --max-turns 80 --strict-mcp-config --mcp-config {"mcpServers":{}} --setting-sources project --settings {"hooks":{},"outputStyle":"default"} --allowedTools Read Grep Glob "Bash(git diff:*)" "Bash(git show:*)" "Bash(git log:*)" "Bash(git grep:*)" --disallowedTools Edit Write NotebookEdit "Bash(git push:*)" "Bash(git commit:*)"` | No MCP servers, no hooks, no user-level settings; read and search tools plus four read-only git commands; editing, committing and pushing are disallowed. Run with `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` and `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`: no CLAUDE.md loads itself (not `~/.claude/CLAUDE.md`, not one in a folder above the repository, not the repository's own) and no auto-memory; the judge reads the repository's rules as files, like every other judge. Verified in Claude Code 2.1.285: with an older or unreadable version the record says the isolation is unverified |
| `cursor-agent` | `-p --print --output-format json --trust --mode ask --model <model or auto> <prompt>` | Ask mode, which is read-only; Rigour's adapter treats it as unable to run git, so every input is named as a file. `--trust` trusts the workspace without prompting. It also reads your own Cursor rules and settings; the review record says so |
| `codex` | `exec --sandbox read-only --json -c model_reasoning_effort=high <prompt>` | Codex's read-only sandbox. Codex has no switch that skips a person's `~/.codex/config.toml` and `~/.codex/AGENTS.md` while keeping their login, so it still reads them; the review record says so for each Codex judgement where they exist |

**What a judge knows.** A judge should know the repository and what Rigour gives it (the diff, the reviews, the team's lessons and rules), not the person running it: the same change gets the same judge on every machine. That holds for `claude` (2.1.285 or later) and for the API judge, which reads no local config at all. The repository's rules reach every judge the same way: Rigour reads AGENTS.md, CLAUDE.md, the Copilot instructions and Cursor rules, the AGENTS.md and CLAUDE.md files in folders below the root (a folder's rules apply to that folder only; vendored folders are skipped), and every file they import with an `@path` line inside the repository, and serves the rules that apply to the change. For `codex` and `cursor-agent` it holds only where the person has no config of their own, and the record of each review names what else the judge read (`outside_repo` on the judge).

The prompt is passed as an argument, never through a shell, and stdin is closed. A team can cap the reviewer's spend with `max_runs_per_day` and `max_usd_per_day`. See [The reviewer](./REVIEWER.md).

Each CLI runs with your environment, because that is how it finds its own login or API key, with two exceptions. `RIGOUR_API_KEY` (Rigour's model-review key) is never passed to a judge. And a team can keep any other variable from a judge with `review.reviewer.judge_env`, for example when `OPENAI_API_KEY` holds a key for a gateway rather than for OpenAI:

```yaml
review:
  reviewer:
    judge_env:
      codex: { unset: [OPENAI_API_KEY] }
```

### Installs and package managers

| Destination | When | What is sent | How to turn it off |
| --- | --- | --- | --- |
| Your npm registry (`npm install @xenova/transformers@2.17.2` into `~/.rigour/runtime/semantic`) | `rigour setup`, once per machine, skipped when less than about 1 GB is free | A normal npm install, with `--no-audit --no-fund --omit=dev` | `rigour setup --no-semantic`. Recall and pattern matching then use keywords |
| `huggingface.co` (the embedding model `Xenova/all-MiniLM-L6-v2`) | The first time Rigour computes an embedding after the library above is installed: indexing, recall, Studio's background index, the duplication check. The library caches it inside its own install directory | A GET by the library, whose default model host is Hugging Face | Do not install the library (`--no-semantic`) |
| Your npm registry, through `npx --yes @rigour-labs/cli@<version>` | Every agent hook and git's pre-push hook run the CLI pinned to the version that installed them. npx resolves it through the machine's npm configuration (registry, proxy, cache) | What npm sends for a package fetch | Pre-populate the npm cache, or point npm at an internal registry |
| Your npm registry, through `npx -y @rigour-labs/mcp@<major>` | The MCP server entry `rigour setup` registers at user level and `rigour setup --team` writes to `.mcp.json` and `.cursor/mcp.json`. The agent starts it | As above | As above |
| Your npm registry, through `npm audit --json` (or `pnpm audit`, `yarn npm audit`, by lockfile) | `rigour security-audit`; `rigour check-pattern` and the `rigour_check_pattern` MCP tool when the intent mentions an import; the `rigour_security_audit` MCP tool. Cached for an hour per lockfile in `.rigour/security-cache.json` | Your dependency tree, as `npm audit` sends it | Do not run those commands or tools |
| `registry.npmjs.org`, or `gates.deprecated_dependencies.registry` | The deprecated-dependencies check, which is off by default (`gates.deprecated_dependencies.enabled: false`). Answers are cached a day in `.rigour/deprecated-dependencies.json` | One GET per installed dependency: its name and version (at most 300) | Leave it off, or set `registry` to an internal mirror |
| `registry.npmjs.org/@rigour-labs/cli/latest` | The update check: at most once a day when you run a CLI command, cached in `~/.rigour/version-cache.json` | A plain GET; nothing about you or your code | Never runs in CI (`CI` or `GITHUB_ACTIONS` set), in `rigour hooks ...`, with `DO_NOT_TRACK` set to anything but `0`, or with `RIGOUR_UPDATE_CHECK=0` |

### Team, GitHub and telemetry

| Destination | When | What is sent | How to turn it off |
| --- | --- | --- | --- |
| Your team PostgreSQL database | Only when team mode is configured (`rigour team configure`, `~/.rigour/team.json` or `RIGOUR_TEAM_*` variables). Sync runs on `rigour team sync`, after each Rigour MCP tool call, and every 30 seconds while Studio is open. `rigour team doctor`, `rigour team semantic-search` and Studio's health view also connect | Lessons from the team's own repositories: kind, subject, evidence, confidence, visibility and ids. Personal lessons stay local unless `syncPersonal` is on. A lesson from a repository not on the team's list stays local; with no list, nothing is sent | Do not configure team mode. See [Sharing lessons through a team database](./TEAM_DATABASE.md) |
| `api.github.com`, or `GITHUB_API_URL` | `rigour review-post` in GitHub Actions | The findings from a `rigour review --json` report: at most `--max-comments` inline comments (default 2) and one summary comment, with the workflow's `GITHUB_TOKEN` | Do not run `review-post` |
| The URL in `review.reviewer.api.url` | `rigour review --reviewer`, the push gate and the background review, when `api` is in `review.reviewer.reviewers` and the variable named by `key_env` is set | The review prompt, the review's inputs (the diff, the human reviews, the description, the team knowledge file) and whatever repository files, searches and git history the model asks its read-only tools for, with the key from `key_env`. The tools read only inside the checkout and the review's input folder; git runs only log, show, diff, blame, grep, ls-files, rev-parse and merge-base | Leave `api` out of `reviewers` |
| `api.github.com`, or `GITHUB_API_URL`; plus `git fetch origin pull/<n>/head` | `rigour learn-reviews` | Read-only requests for merged pull requests, their review comments and their reviews, with `GH_TOKEN` / `GITHUB_TOKEN`, else the token of the account named by `review.github_account` / `RIGOUR_GITHUB_ACCOUNT` (`gh auth token --user`), else `gh auth token`. Lessons are written to `.rigour/review-lessons.json` and go nowhere else | Do not run `learn-reviews` |
| `api.mixpanel.com/track?ip=0` | Opt-in telemetry only, after you said yes. Never from builds without a token | Anonymous counts and buckets, listed field by field in [Telemetry](../TELEMETRY.md) | `rigour telemetry off`, `RIGOUR_TELEMETRY=0`, or `DO_NOT_TRACK` set |
| `api.cursor.com/teams/filtered-usage-events` | Rigour contains a client for Cursor's Admin API, read with a key from `RIGOUR_CURSOR_API_KEY`, `CURSOR_ADMIN_API_KEY` or `cursor.apiKey` in settings. No Rigour command, hook or MCP tool calls it in this version | Date range and paging, with the admin key | Do not set a Cursor admin key |
| Downstream MCP servers | Only with the MCP gateway (`rigour-mcp --gateway`) and a gateway configuration in `~/.rigour/control/<repository id>/gateway.json`. Rigour starts each listed server as a local process over stdio | What the agent passes to the allowed tools. Whatever network those servers use is theirs | Do not configure the gateway |
| Any git URL you give | `rigour demo --repo <url>` clones it (`git clone --depth 1`) | A git clone | Do not use `--repo` |
| Google Fonts (`fonts.googleapis.com`, `fonts.gstatic.com`) | Your browser, when it opens Rigour Studio | What a browser sends for a font request | The page falls back to system fonts when they cannot load |

Rigour Studio itself listens on `127.0.0.1` only. It answers requests whose `Host` header names its own loopback ports, and every write needs a per-launch key that is printed in the terminal link (in the URL fragment, which browsers do not send to a server).

At push, Rigour also runs your repository's own formatter, linter, type checker and related tests. Any network use by those tools is theirs.

## Where keys and credentials are kept

| What | Where | Stored how |
| --- | --- | --- |
| Model provider keys (`rigour settings set-key <provider> <key>`) | `~/.rigour/settings.json` (`rigour settings path` prints it) | Plain JSON. The file is written with mode `0600` and its directory set to `0700`, where the platform supports it |
| A key for one run | `-k <key>`, or `RIGOUR_API_KEY` | Not stored. A key on the command line can show in shell history and process lists; in CI use `RIGOUR_API_KEY` from a secret |
| Cursor admin key | `RIGOUR_CURSOR_API_KEY` or `CURSOR_ADMIN_API_KEY`, else `cursor.apiKey` in `settings.json` | Environment first; the file as above |
| Team database URL | `RIGOUR_TEAM_DATABASE_URL`, else the output of `RIGOUR_TEAM_DATABASE_URL_COMMAND` (a command that prints it, for example from a keychain; run once per process and never stored), else `~/.rigour/team.json` | `team.json` is plain JSON, mode `0600`. A remote URL must use `sslmode=require` or `sslmode=verify-full`; only `localhost`, `127.0.0.1` and `::1` are exempt |
| GitHub tokens | Not stored by Rigour. `GITHUB_TOKEN`, `GH_TOKEN`, or the token `gh` holds | |
| Profiles | `~/.rigour/profiles.json` in your real home (or `RIGOUR_PROFILES`) | Plain JSON, mode `0600`. A profile's team database is given as a command, never a URL |

## What Rigour keeps on disk

### In Rigour's home (`~/.rigour`, or `$RIGOUR_HOME/.rigour`)

| Path | Contents |
| --- | --- |
| `settings.json`, `team.json`, `profiles.json` | As above |
| `rigour.db` | SQLite: scan results and findings, learned patterns, the codebase index, context and model-usage counters, lessons, the team sync outbox, the repository registry, and interaction evidence |
| `team-cache.key` | The local encryption key (below), mode `0600` |
| `telemetry.json`, `telemetry-counters.json` | Your telemetry choice, a random install id, and the day's local counts |
| `version-cache.json` | The last version the update check saw |
| `models/`, `bin/llama-b5604/` | Local model files and the llama.cpp engine |
| `runtime/semantic/` | The semantic search library, shared by every Rigour version on the machine |
| `repos/<hash>/` | Per-repository state kept out of the working tree, so an agent editing the repository cannot rewrite it |
| `control/<hash>/` | Trusted control-plane files such as the MCP gateway configuration |

### Encryption

Lesson evidence, interaction evidence and the team sync outbox in `rigour.db` are encrypted with AES-256-GCM, each value with a random 12-byte IV. The key is `RIGOUR_LOCAL_CACHE_KEY` (base64, 32 bytes) when set, otherwise `~/.rigour/team-cache.key`, created on first use with mode `0600`. Other tables, such as findings and the index, are not encrypted. When the key file sits next to the database, the encryption protects a copy of the database taken without the key, not against someone who can read your home directory. Lessons sent to a team database are decrypted first and stored there as JSON.

### In the repository

| Path | Committed? | Contents |
| --- | --- | --- |
| `rigour.yml` | With `rigour setup --team` | The team's settings |
| `.mcp.json` (Claude Code) and `.cursor/mcp.json` (Cursor), and the hook configs of the agents the repository uses (`.claude/settings.json`, `.cursor/hooks.json`, and so on) | With `rigour setup --team` | The MCP server entry and hook commands, which run `npx` with a pinned version |
| `AGENTS.md` and a one-line `CLAUDE.md` | Only with `rigour setup --team --instructions` | Instructions for agents |
| `.rigour/dismissed.json`, `.rigour/dismissed-review-items.json`, `.rigour/reviewed.json`, `.rigour/backtest.json` | Yes, in a team repository. `rigour init` (which `rigour setup --team` runs when the repository has no `rigour.yml`) adds `.rigour/*` to `.gitignore` with these four excepted | Dismissed findings, reviewer items dismissed, functions already reviewed (hashes and verdicts only), and the backtest ledger |
| Everything else under `.rigour/` | No | Caches, the Studio event log (`events.jsonl`), learned review lessons and the rule writer's log, files as the agent last wrote them (`agent-writes/`, to notice a person's correction; each is removed once compared), DLP feedback, backtest results |

A personal `rigour setup` writes nothing to the working tree: it adds `.rigour/` to `.git/info/exclude`, puts a marker and the pre-push hook in the git directory, and installs agent hooks once in each agent's user-level configuration. Those hooks do nothing in a repository that has not been switched on.

### In the git directory

The reviewer keeps its verdicts, and the record of each review (what was verified, reported and decided, with an integrity hash), in `<git common dir>/rigour-reviewer/`, never in the working tree and never through team sync, because a verdict and its record quote code and review text. A verdict also keeps each judge run's trace, for measuring cost: the tokens of each turn and the paths and commands the judge's tools read (not their contents). The backtest checks out rounds in `<git common dir>/rigour-backtest/`.

## The DLP hooks

Setup installs a credential scan that runs before the agent acts: Claude Code's `PreToolUse` on every tool, Cursor's `beforeSubmitPrompt`, Cline's `PreToolUse` and Windsurf's `pre_write_code`. It looks for cloud and API keys, private keys, database connection strings, bearer tokens and JWTs, and password or secret assignments.

- It runs locally and sends nothing.
- As installed, it warns: the hook commands do not pass `--block`, so a detection is reported to you and the agent continues.
- Detections carry only a redacted match. After a warning that was wrong, `rigour hooks check --dlp-allow-last` records a fingerprint of it in `.rigour/dlp-feedback.json` so it is not raised again.
- It scans text. It cannot read images, and the MCP server says so when a request carries one.

## For an air-gapped setup

Set these for every user and CI job:

```bash
export RIGOUR_UPDATE_CHECK=0   # no update check
export RIGOUR_TELEMETRY=0      # no telemetry, whatever was chosen
```

Then:

| Step | How |
| --- | --- |
| Install | From an internal npm registry or mirror. Agent hooks and the MCP entry run `npx --yes @rigour-labs/cli@<version>` and `npx -y @rigour-labs/mcp@<major>`, which must resolve there or from the npm cache |
| Setup | `rigour setup --no-semantic` (or install `@xenova/transformers@2.17.2` from your mirror; its embedding model is still fetched from Hugging Face on first use) |
| Model review | Leave `--deep`, `--pro`, `--max` and `-k` off. For a local model, run `rigour deep pull` (add `--pro` for the larger model) on a connected machine and copy `~/.rigour/bin` and `~/.rigour/models`, or pass `--model-path <file.gguf>` with `llama-cli` on `PATH`. For an internal endpoint, use `-k <key> --provider <name> --api-base-url <url> --model-name <model>`: an OpenAI-compatible server, or a gateway in front of Anthropic with `--provider claude` |
| Reviewer | Keep `review.reviewer.enabled: false`, or accept that the agent CLIs reach their vendors |
| Checks that call out | Keep `gates.deprecated_dependencies.enabled: false` (the default) or set its `registry`; do not run `rigour security-audit`, or point npm at a mirror |
| Team | No team database, or one on your network |
| Studio | Works offline; fonts fall back to system fonts |

## Reporting a vulnerability

The repository has no security contact. Report a vulnerability privately through a GitHub security advisory on [rigour-labs/rigour](https://github.com/rigour-labs/rigour/security/advisories/new), not in a public issue.
