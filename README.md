# Rigour

[![npm version](https://img.shields.io/npm/v/@rigour-labs/cli?color=4f46e5&label=cli)](https://www.npmjs.com/package/@rigour-labs/cli)
[![npm downloads](https://img.shields.io/npm/dm/@rigour-labs/cli?color=2563eb&label=downloads)](https://www.npmjs.com/package/@rigour-labs/cli)
[![License: MIT](https://img.shields.io/badge/license-MIT-facc15.svg)](https://opensource.org/licenses/MIT)
[![MCP Registry](https://img.shields.io/badge/MCP-Listed-22c55e)](https://rigour.run)

**Your AI agent writes the code. Rigour makes sure it's right before anyone has to review it.**

Coding agents are fast, and they make mistakes with confidence: an export nothing uses, a query that re-reads the whole table on every page, a fix that came back after the reviewer already flagged it. Today a human finds those at the pull request, round after round. Rigour checks the work while the agent is still writing, at the moments that matter, and the agent fixes it before anyone else has to look.

Works with Claude Code, Cursor, Codex, Cline and Windsurf. Free, open source, and runs on your machine.

## What makes Rigour different

- **It works at the three moments that matter, not only at the pull request.** On every edit, before your agent says "done", and before it pushes. Most problems are fixed before a pull request exists.
- **It remembers what your reviewer said last time.** Before a push, a fresh reviewer checks every point from the last human review against the code, so a fix that only covered half of a comment is caught, not shipped. It uses your agent's own login: no API key.
- **It reports what you changed, not what was already there.** Old problems in code you touched stay out of your review, so every finding is yours to fix.
- **It runs your team's own tools.** Your formatter, linter, type check and the tests that touch the change run before every push, without anyone remembering to.
- **It only blocks on what it can prove.** Dead code, offset paging, unbounded time windows, copied functions, merge conflicts, stale references: each check was run over real merged pull requests before it was allowed to block. Anything less certain is a note, never a gate.
- **It shows its work.** Every review ends with a receipt: which risky changes were reviewed during development, which changed after review, and which nobody looked at.
- **One machine, many companies, nothing crosses.** Profiles keep each employer's or client's memory, lessons and team apart, chosen by the repository you're in.

## How it works

| When | What Rigour does | If something's wrong |
| --- | --- | --- |
| Every edit | Fast checks on the file: secrets, imports that don't exist, proven bugs | The agent sees it at once |
| Before "done" | The whole branch against main: findings to fix, code nothing uses, risky patterns, a merge conflict | The agent keeps working (at most three times) |
| Before `git push` | The same, plus your formatter, linter, type check and related tests, and the reviewer that remembers | The push is blocked, one line per problem |
| On the pull request | A quiet safety net: at most two comments, only on what wasn't already checked | — |

## Get started

```bash
brew install rigour-labs/tap/rigour    # or: npm install -g @rigour-labs/cli
rigour setup                           # in your repository
```

`rigour setup` connects Rigour to your agents, installs the three moments, and checks that everything works. Already set up before the push gate existed? Run `rigour hooks init --force` once.

Using Claude Code? The plugin does all of it:

```text
/plugin marketplace add rigour-labs/rigour-plugin
/plugin install rigour@rigour-labs
```

Want the reviewer at every push too? Add this to `rigour.yml`:

```yaml
review:
  reviewer:
    enabled: true
```

Then open Studio to watch it work:

```bash
rigour studio
```

## Four commands

| Command | What it does |
| --- | --- |
| `rigour setup` | Gets your repository ready and checks it works |
| `rigour review` | Reviews your current change, or a branch before you open a PR (`--reviewer` adds the reviewer that remembers) |
| `rigour studio` | Shows what Rigour stopped, learned and gave your agents |
| `rigour doctor` | Tells you what's working, what isn't, and how to fix it |

Everything else is in `rigour help --all`.

## Built to be trusted

- **It never cries wolf.** A check blocks only after it has been measured on real pull requests. Guesses about style or size never block you and never show up on a PR.
- **Say "not a bug" once.** That finding never comes back, and checks your team keeps overruling go quiet on their own.
- **When it can't check, it says so.** No reviewer answer, nothing to review, a tool that isn't installed: each is reported plainly, never as a clean pass.
- **Your code stays on your machine.** Nothing is sent anywhere unless you add a model key; team sync sends only lessons from your team's own repositories.
- **You see what it costs.** When a model is used, Rigour records the real cost of each run.
- **Measured in the open.** Claims about what Rigour catches are tested on real pull requests in the public [driftbench arena](https://github.com/rigour-labs/driftbench).

## What it costs

Rigour is free. With an agent you need nothing else: the checks run locally, and the reviewer and the review of risky changes use your agent's own model and login. A model key is only for reviewing code written without an agent, and for the pull request bot.

## For teams

**Pull request bot.** Add one workflow file and Rigour reviews every PR, quietly. With `enforce: true` it becomes a required check, and a PR can't dismiss its own findings. See [PR Bot](docs/PR_BOT.md).

**Shared knowledge.** Point Rigour at a PostgreSQL database and lessons one person's agent learns can be shared with the whole team, after someone approves them. Only lessons from the team's own repositories are ever sent. See [Enterprise & Teams](docs/ENTERPRISE.md).

**Working for more than one company?** Profiles keep each one's memory, lessons and team apart, chosen by the repository you're in. See [Profiles](docs/PROFILES.md).

## Learn more

| If you want to… | Read |
| --- | --- |
| Install and run Rigour step by step | [Quick Start](docs/QUICK_START.md) |
| Connect a coding agent | [Agent Integration](docs/AGENT_INTEGRATION.md) · [MCP Integration](docs/MCP_INTEGRATION.md) |
| Set up the pull request bot | [PR Bot](docs/PR_BOT.md) |
| Use your own model key | [Deep Analysis](docs/DEEP_ANALYSIS.md) |
| Tune what Rigour checks | [Configuration](docs/CONFIGURATION.md) |
| Work across several companies on one machine | [Profiles](docs/PROFILES.md) |
| See how each check is measured | [Accuracy](docs/ACCURACY.md) |
| Know exactly what is collected | [Telemetry](TELEMETRY.md): opt-in, anonymous, never code |

## Build from source

```bash
pnpm install
pnpm build
pnpm test
```

---

**[Documentation](https://docs.rigour.run)** · **[Discussions](https://github.com/rigour-labs/rigour/discussions)** · **[Issues](https://github.com/rigour-labs/rigour/issues)**

MIT © [Rigour Labs](https://github.com/rigour-labs) · Built by [Ashutosh](https://github.com/erashu212)
