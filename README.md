# Rigour

[![npm version](https://img.shields.io/npm/v/@rigour-labs/cli?color=4f46e5&label=cli)](https://www.npmjs.com/package/@rigour-labs/cli)
[![npm downloads](https://img.shields.io/npm/dm/@rigour-labs/cli?color=2563eb&label=downloads)](https://www.npmjs.com/package/@rigour-labs/cli)
[![License: MIT](https://img.shields.io/badge/license-MIT-facc15.svg)](https://opensource.org/licenses/MIT)
[![MCP Registry](https://img.shields.io/badge/MCP-Listed-22c55e)](https://rigour.run)

**Your AI agent writes the code. Rigour makes sure it's right before anyone has to review it.**

Coding agents are fast, and they make mistakes with confidence: a live API key in a test file, an import of a package that doesn't exist, a refund that can go through twice. Today those mistakes surface at the pull request, or in production. Rigour catches them while the agent is still writing, and the agent fixes them on the spot. Your pull requests arrive clean.

Works with Claude Code, Cursor, Codex, Cline and Windsurf. Free, open source, and runs on your machine.

## What you get

- **Mistakes stopped as they're written.** Leaked secrets, imports that don't exist, and bugs Rigour can prove are caught on every edit. The agent fixes them before moving on.
- **A second look at the risky parts.** Before your agent says "done", Rigour points it at the changes most likely to hide a bug and asks it specific questions. It uses the model you already pay for.
- **Nothing pushed unchecked.** Before your agent says "done", and again before it pushes, Rigour checks the whole branch: your own formatter, linter, type checker and the tests that touch the change, plus code the change added that nothing uses.
- **A reviewer that remembers.** Optionally, before each push a fresh reviewer checks every point your human reviewer raised last time against the code, then looks for anything new. It runs on your own agent's login, with no key.
- **A quiet safety net on pull requests.** At most two comments, only on what wasn't already checked, never repeated.
- **It learns your codebase.** A mistake fixed once becomes a lesson your agents are told before they write similar code, so it isn't repeated.
- **Proof you can see.** Studio shows what was stopped this week, what Rigour learned, and how often you overruled it.

## Get started

```bash
brew install rigour-labs/tap/rigour    # or: npm install -g @rigour-labs/cli
rigour setup                           # in your repository
```

`rigour setup` connects Rigour to your agents and checks that everything works. It ends by telling you the one thing left to do, usually a single command to give your agent the Rigour tools.

Using Claude Code? The plugin does all of it:

```text
/plugin marketplace add rigour-labs/rigour-plugin
/plugin install rigour@rigour-labs
```

Then open Studio to watch it work:

```bash
rigour studio
```

## Four commands

| Command | What it does |
| --- | --- |
| `rigour setup` | Gets your repository ready and checks it works |
| `rigour review` | Reviews your current change, or a branch before you open a PR |
| `rigour studio` | Shows what Rigour stopped, learned and gave your agents |
| `rigour doctor` | Tells you what's working, what isn't, and how to fix it |

Everything else is in `rigour help --all`.

## Built to be trusted

- **It only speaks when it can prove it.** Guesses about style or size never block you and never show up on a PR.
- **It reports what you changed, not what was already there.** An old problem in code you touched isn't put on your change.
- **Say "not a bug" once.** That finding never comes back, and checks your team keeps overruling go quiet on their own.
- **Your code stays on your machine.** Nothing is sent anywhere unless you add a model key, and then only the riskiest changes go to the model.
- **You see what it costs.** When a model is used, Rigour records the real cost of each run.
- **Measured in the open.** Claims about what Rigour catches are tested on real pull requests in the public [driftbench arena](https://github.com/rigour-labs/driftbench).

## What it costs

Rigour is free. With an agent you need nothing else, because your agent does the reviewing with its own model. A model key is only for reviewing code written without an agent, and for the pull request bot. A pull request with nothing risky in it costs nothing.

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
