# Quick start

One path, four steps. Each step is safe to stop at.

## 1. See what it finds, changing nothing

On a branch with work on it, in your repository:

```bash
npx @rigour-labs/cli review --base origin/main
```

This reviews what the branch changed against main and prints what must be fixed. It writes nothing to your project except Rigour's own state folder, `.rigour/`. If what it shows is not worth your time, stop here.

## 2. Set it up

```bash
npm install -g @rigour-labs/cli     # or: brew install rigour-labs/tap/rigour
rigour setup
```

`rigour setup` is **personal** by default: nothing in your working tree, nothing to commit. It:

- switches Rigour on for this repository with a marker inside `.git/`, and adds `.rigour/` to `.git/info/exclude` (not your `.gitignore`);
- installs the agent hooks **once per machine**, in each agent's user-level config: `~/.claude/settings.json`, `~/.cursor/hooks.json`, `~/.codeium/windsurf/hooks.json`, `~/Documents/Cline/Hooks/`. They are merged into what you have (your settings and own hooks stay), and each starts with a guard that stays silent in any repository you have not switched on;
- installs git's `pre-push` hook in `.git/hooks`, so every tool and your terminal go through the same gate;
- registers Rigour's MCP server at user level (`claude mcp add --scope user`, `~/.cursor/mcp.json`);
- installs semantic search, once per machine (about 230 MB, shared by every Rigour version). It lets "have we learned this before?" and "is there already a helper for this?" work by meaning. Skip it with `--no-semantic`.

Settings are Rigour's defaults until you want them shared. It ends by checking that each piece works.

**For a team:** `rigour setup --team` commits Rigour to the repository instead: `rigour.yml`, the project's agent hooks and its MCP server in `.mcp.json`, so everyone who clones gets the same gate. Configs you already have are merged into, never replaced. Agent instruction files (`CLAUDE.md`, `AGENTS.md` and the like, only where you have none) come with `--instructions`. A repository that already commits a `rigour.yml` gets the team setup automatically.

## 3. Work as usual

Your agent edits, says it is done, pushes. Rigour speaks at three moments:

| Moment | What runs | What happens on a problem |
| --- | --- | --- |
| Every edit | Fast checks on the file | The agent sees it at once |
| Before the agent says "done" | The whole branch against main: findings to fix, code nothing uses, a merge conflict with main | The agent keeps working (at most three times) |
| Before `git push` | The same, plus your formatter, linter, type check and related tests, and what a change made redundant | The push is refused, one line per problem |

Nothing advisory blocks: a check blocks only after it has been measured on real pull requests.

`rigour doctor` says what is working and what is not. `rigour hooks selftest` proves the push gate with a real push to a scratch remote.

## 4. Take it back out

```bash
rigour uninstall --dry-run    # what would be removed
rigour uninstall              # remove it
```

In a personal install this switches Rigour off for the repository and removes its git hook; the machine-level hooks stay, silent everywhere you have not switched Rigour on. `rigour uninstall --machine` removes those too, with the user-level MCP server and the shared semantic search, leaving your agents' configs as they were before.

In a team install it removes Rigour's hook entries and MCP server from the committed configs (everything else in them stays), the files it created that you have not edited since, and its git hook. A file it created that you have edited is kept and named.

Either way, `.rigour/` (your dismissals and backtest ledger) and any `rigour.yml` stay unless you add `--all`.

---

## When you want more

- **The reviewer.** A read-only review by your coding agent's own CLI that checks every point of every human review against the code. See `review.reviewer` in the [configuration](./CONFIGURATION.md).
- **Measure it on your history.** `rigour backtest` replays the review on commits your team reviewed and scores it against what they found. See [Backtest](./BACKTEST.md).
- **Watch it work.** `rigour studio`.
- [Configuration](./CONFIGURATION.md), [Agent integration](./AGENT_INTEGRATION.md), [Profiles](./PROFILES.md).
