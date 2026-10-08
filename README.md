# Rigour

[![npm version](https://img.shields.io/npm/v/@rigour-labs/cli?color=4f46e5&label=cli)](https://www.npmjs.com/package/@rigour-labs/cli)
[![npm downloads](https://img.shields.io/npm/dm/@rigour-labs/cli?color=2563eb&label=downloads)](https://www.npmjs.com/package/@rigour-labs/cli)
[![License: MIT](https://img.shields.io/badge/license-MIT-facc15.svg)](https://opensource.org/licenses/MIT)
[![MCP Registry](https://img.shields.io/badge/MCP-Listed-22c55e)](https://rigour.run)

**A reviewer that knows how your team works, whichever agent writes the code.**

Whichever agent your engineers use, its work arrives already shaped by how your team builds software, and it gets closer to your standards every week.

Teams used to carry their judgment through people: the senior who briefed you before you started, the reviewer who caught what you missed, the engineer who remembered why the last attempt failed. Coding agents write faster than any person can brief, review or remember. The knowledge is still in your team; Rigour is how it reaches every agent, at the speed agents work.

Works with Claude Code, Cursor, Codex, Cline and Windsurf. Free, open source, and runs on your machine.

## How it does it

1. **Brief before writing.** Before an agent edits a file, it is told what your team asks of that file: the rules your repository wrote for it, the lessons your team learned on it, the points your team settled against. At most three items per file, each cited. Opt-in: `rigour hooks init --brief`, or `rigour_brief` for any agent with MCP. See [The briefing](docs/BRIEF.md).
2. **Verify while writing and before push.** Your team's checks and rules gate any agent's work: on every edit, before the agent says "done", and before `git push`, where your formatter, linter, type check and the tests that touch the change run too. Opt-in, the change is also checked against the goal its pull request declares: files outside its scope, "done when" items it never did. See [The goal check](docs/GOAL.md).
3. **Review with your team's context, at your team's severity.** A reviewer that reads every point from your last human review, checks each rule your repository wrote that the change touches, and takes your reviewer's own "Blocking / Should fix / Nits" over its own reading. What your team blocks and what it lets go is your repository's setting, not one global opinion. See [The reviewer](docs/REVIEWER.md).
4. **Learn from outcomes.** A review point becomes a lesson only on evidence: the lines it named were fixed later, a person corrected an agent's work, someone on the team decided, or it recurred across authors. What it learns flows into the next briefing and the next review.

One piece of work is one **task**, whatever agents and people touch it, and `rigour thread` shows everything that happened to it: what was caught while the code was written and fixed before the push, what blocked, what each review found. See [The task thread](docs/THREAD.md).

## What it is, and what it is not

- **It learns only from evidence**: your rules files, review points that were acted on, people's corrections, and what happened after merge. A guess never becomes a rule.
- **It shapes and checks the agent; it never changes the model.** No training, no fine-tuning. Any agent, any model.
- **Concrete taste it captures well** ("bound the window at both ends", "rerun the code generator after changing the schema"). Design taste stays with your people: anything Rigour cannot show in code is a should-fix at most, never a block.
- **One machine, many companies, nothing crosses.** Profiles keep each employer's or client's memory, lessons and team apart, chosen by the repository you're in. See [Profiles](docs/PROFILES.md).
- **It starts from what you have written down.** On day one, the briefing and the reviewer carry your repository's own rules (AGENTS.md, CLAUDE.md, Cursor rules, Copilot instructions). Lessons join as your reviews give them evidence, so a team with little review history starts with little to brief, and the briefing is off until you turn it on.

## What runs by default, and what it costs

| | Default | Cost |
| --- | --- | --- |
| Checks on every edit, before "done", before push | On after `rigour setup` | Local; the after-edit check starts the CLI once per edit |
| Your team's tools before push | On | Your own formatter, linter, type check and tests |
| The reviewer | Off until enabled in Studio or `rigour.yml` | Your agent's own model and login, one long read per review; the record of each review shows its cost |
| A panel of judges | Off; `mode: full` or `panel: on` | One judge's cost per judge, plus a short cross-examination of what they disagree on |
| A judge through any OpenAI-compatible API | Off; `reviewers: [api]` | The provider's price for your key |
| The briefing | Off; `rigour hooks init --brief` | No model; with the credential scan on, +22 ms per edit and +121 ms on a file's first edit (measured on Rigour's own repository) |
| The task thread | On wherever the hooks run | A line per event in your git folder |

## How it works

| When | What Rigour does | If something's wrong |
| --- | --- | --- |
| Every edit | Fast checks on the file: secrets, imports that don't exist, proven bugs | The agent sees it at once |
| Before "done" | The whole branch against main: findings to fix, code nothing uses, risky patterns, a merge conflict | The agent keeps working (at most three times) |
| Before `git push` | The same, plus your formatter, linter, type check and related tests, and the reviewer that remembers | The push is blocked, one line per problem |
| On the pull request | A quiet safety net: at most two comments, only on what wasn't already checked | — |

With the briefing on, a line comes before all of these: before each file's first edit, what your team asks of that file.

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
| `rigour brief` | What your team would tell an agent before this task: rules, lessons and settled points, each cited |
| `rigour thread` | What happened to a task, across agents, checks, pushes and reviews |
| `rigour review` | Reviews your current change, or a branch before you open a PR (`--reviewer` adds the reviewer that remembers; `--scope` lists what a fix round changed that the review never asked for) |
| `rigour studio` | Shows what Rigour stopped, learned and gave your agents |
| `rigour doctor` | Tells you what's working, what isn't, and how to fix it |
| `rigour uninstall` | Takes out exactly what Rigour put in; your own settings and edited files stay |

Everything else is in `rigour help --all`.

## Built to be trusted

- **It blocks only on what it can show.** A deterministic check blocks only after it has been run over real merged pull requests. The model reviewer's findings block only when they name a wrong outcome or a cost, and with a panel, only when most judges agree. Guesses about style or size never block you and never show up on a PR.
- **Say "not a bug" once.** That finding never comes back, and checks your team keeps overruling go quiet on their own.
- **When it can't check, it says so.** No reviewer answer, nothing to review, a tool that isn't installed: each is reported plainly, never as a clean pass.
- **Your code stays on your machine.** The checks run locally. Code leaves only for a model you choose: your agents' own CLIs for the reviewer, or a provider when you run a model review with your key. Team sync sends only lessons from your team's own repositories. Every network call Rigour can make, and how to turn each off, is in [Security](docs/SECURITY.md).
- **You see what it costs.** When a model is used, Rigour records the real cost of each run.
- **You see what each judge knew.** A judge reads your repository and what Rigour gives it. The Claude judge loads no one's personal instructions; where a judge cannot be kept from a person's own config (Codex, Cursor), the record of the review says what else it read.
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
| See what changed in this release, and how to upgrade | [Release notes](docs/releases/6.8.0.md) |
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
