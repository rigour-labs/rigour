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
- **A second opinion that agrees by evidence, not by volume.** Run one judge, or a panel of two or three from different vendors. The panel matches their findings, cross-examines only what they disagree on, and blocks only on what most of them raise, or confirm with a `file:line` from your code. An opinion ("this could be cleaner") never blocks. See [The reviewer](docs/REVIEWER.md).
- **It starts from what your team already knows.** Every judge is told which lessons and rules apply to the files changed, what your checks already found, which docs describe the code and, if your team allows dismissals, which findings it settled.
- **It reports what you changed, not what was already there.** Old problems in code you touched stay out of your review, so every finding is yours to fix.
- **It runs your team's own tools.** Your formatter, linter, type check and the tests that touch the change run before every push, without anyone remembering to.
- **It only blocks on what it can prove.** Dead code, offset paging, unbounded time windows, copied functions, merge conflicts, stale references: each check was run over real merged pull requests before it was allowed to block. Anything less certain is a note, never a gate.
- **It shows its work.** Once your agents are reviewing as they go, every review ends with a receipt: which risky changes were reviewed during development, which changed after review, and which nobody looked at.
- **One machine, many companies, nothing crosses.** Profiles keep each employer's or client's memory, lessons and team apart, chosen by the repository you're in.

## How it works

| When | What Rigour does | If something's wrong |
| --- | --- | --- |
| Every edit | Fast checks on the file: secrets, imports that don't exist, proven bugs | The agent sees it at once |
| Before "done" | The whole branch against main: findings to fix, code nothing uses, risky patterns, a merge conflict | The agent keeps working (at most three times) |
| Before `git push` | The same, plus your formatter, linter, type check and related tests, and the reviewer that remembers | The push is blocked, one line per problem |
| On the pull request | A quiet safety net: at most two comments, only on what wasn't already checked | — |

## Get started

See what it finds first, changing nothing (on a branch with work on it):

```bash
npx @rigour-labs/cli review --base origin/main
```

Worth it? Set it up:

```bash
brew install rigour-labs/tap/rigour    # or: npm install -g @rigour-labs/cli
rigour setup                           # in your repository
```

`rigour setup` connects Rigour to your agents, installs the three moments, and checks that everything works. By default it is **personal: nothing in your working tree**. The agent hooks are installed once per machine and stay silent in any repository you have not switched on, and switching this one on writes only inside `.git/`. When your team wants it for everyone who clones, `rigour setup --team` commits it to the repository instead. Either way it merges into the agent configs you already have rather than replacing them. Changed your mind? `rigour uninstall` takes out exactly what it put in. [Get started](docs/QUICK_START.md) walks through it.

Rigour is about 70 MB per version. Semantic search (about 230 MB) is installed once per machine by `rigour setup` and shared by every version; skip it with `--no-semantic`.

Using Claude Code? The plugin does all of it:

```text
/plugin marketplace add rigour-labs/rigour-plugin
/plugin install rigour@rigour-labs
```

Want the reviewer too? It is off until someone turns it on, and you choose how far to take it: for yourself in Studio's **Setup** page, or for the whole team in `rigour.yml`:

```yaml
review:
  reviewer:
    enabled: true
    mode: full          # one judge per vendor, up to `judges`; single (the default) is one judge
    panel: on           # only what most judges confirm blocks; required: no one may turn it off
    judges: 3           # 2 or 3, one per vendor installed
    escalate: risk      # add judges only for risky changes; measure it with rigour backtest first
```

The push goes through as soon as the checks pass; the reviewer then reads the pushed commit in the background (only when it has an open, non-draft pull request, so you pay for a model only when someone will read the push). `rigour review --status` shows its verdict and what ran; `rigour review --reviewer --full` is the hard stop before you ask a person to review. Your own choice wins for your runs, except where the team set a floor, and Rigour always says which judges actually ran and why.

Then open Studio to watch it work:

```bash
rigour studio
```

## The commands you will use

| Command | What it does |
| --- | --- |
| `rigour setup` | Gets your repository ready and checks it works |
| `rigour review` | Reviews your current change, or a branch before you open a PR (`--reviewer` adds the reviewer that remembers; `--scope` lists what a fix round changed that the review never asked for) |
| `rigour studio` | Shows what Rigour stopped, learned and gave your agents |
| `rigour doctor` | Tells you what's working, what isn't, and how to fix it |
| `rigour uninstall` | Takes out exactly what Rigour put in; your own settings and edited files stay |

Everything else is in `rigour help --all`.

## Built to be trusted

- **It never cries wolf.** A deterministic check blocks only after it has been measured on real pull requests. The model reviewer's findings block only when they name a wrong outcome or a cost, and with a panel, only when most judges agree. Guesses about style or size never block you and never show up on a PR.
- **Say "not a bug" once.** That finding never comes back, and checks your team keeps overruling go quiet on their own.
- **When it can't check, it says so.** No reviewer answer, nothing to review, a tool that isn't installed: each is reported plainly, never as a clean pass.
- **Your code stays on your machine.** The checks run locally. Code leaves only for a model you choose: your agents' own CLIs for the reviewer, or a provider when you run a model review with your key. Team sync sends only lessons from your team's own repositories. Every network call Rigour can make, and how to turn each off, is in [Security](docs/SECURITY.md).
- **You see what it costs.** When a model is used, Rigour records the real cost of each run.
- **Measured in the open.** Claims about what Rigour catches are tested on real pull requests in the public [driftbench arena](https://github.com/rigour-labs/driftbench).
- **Measured against your own reviewers.** `rigour backtest` replays the review on commits your team reviewed, with the review hidden, and scores it: which of the reviewer's points it would have caught first, and whether it would have blocked anything they called good. See [Backtest](docs/BACKTEST.md).
- **One rule for what blocks.** The review, the stop hook and the push gate decide from the same rule, so they never disagree about a finding.

## What it costs

Rigour is free. With an agent you need nothing else: the checks run locally, and the reviewer and the review of risky changes use your agent's own model and login. A model key is only for reviewing code written without an agent, and for the pull request bot.

## For teams

**Pull requests.** Add one workflow file and Rigour reviews every PR, quietly. Make it a required check, and a PR can't dismiss its own findings or loosen its own settings. See [Pull requests and CI](docs/CI.md).

**One setup for everyone.** `rigour setup --team` commits the configuration, and each teammate runs `rigour setup` once after cloning. See [Team setup](docs/TEAM_SETUP.md).

**Shared knowledge.** Point Rigour at a PostgreSQL database and lessons one person's agent learns can be shared with the whole team, after someone approves them. Only lessons from the team's own repositories are ever sent. See [Team database](docs/TEAM_DATABASE.md).

**Working for more than one company?** Profiles keep each one's memory, lessons and team apart, chosen by the repository you're in. See [Profiles](docs/PROFILES.md).

## Learn more

| If you want to… | Read |
| --- | --- |
| Install and run Rigour step by step | [Get started](docs/QUICK_START.md) |
| Know what to do with a finding while you work | [During development](docs/DEVELOPMENT.md) |
| Set it up for a whole team | [Team setup](docs/TEAM_SETUP.md) |
| Review every pull request in CI | [Pull requests and CI](docs/CI.md) |
| See which agents it supports, and its MCP tools | [Coding agents and MCP](docs/AGENTS.md) |
| Run the reviewer, from one judge to a panel | [The reviewer](docs/REVIEWER.md) |
| Use your own model key, or a local model | [Model review](docs/MODEL_REVIEW.md) |
| Tune what Rigour checks | [Configuration](docs/CONFIGURATION.md) · [every setting](docs/CONFIG_REFERENCE.md) |
| See every check, and how accuracy is kept honest | [What Rigour checks](docs/CHECKS.md) |
| Approve it for your organization | [Security and network use](docs/SECURITY.md) · [Telemetry](TELEMETRY.md): opt-in, anonymous, never code |
| Work across several companies on one machine | [Profiles](docs/PROFILES.md) |
| Everything | [Documentation index](docs/README.md) |

## Build from source

```bash
pnpm install
pnpm build
pnpm test
```

See [Contributing](CONTRIBUTING.md).

---

**[Documentation](docs/README.md)** · **[Discussions](https://github.com/rigour-labs/rigour/discussions)** · **[Issues](https://github.com/rigour-labs/rigour/issues)**

MIT © [Rigour Labs](https://github.com/rigour-labs) · Built by [Ashutosh](https://github.com/erashu212)
