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

`rigour setup` writes, and lists as it goes:

- `rigour.yml`, the settings (kept by `rigour uninstall` unless you pass `--all`);
- Rigour's hook entries in your agents' configs (`.claude/settings.json`, `.cursor/hooks.json`, `.windsurf/hooks.json`) and its MCP server in `.mcp.json`. A config you already have is merged into, never replaced: your permissions, settings and own hooks stay;
- agent instructions (`CLAUDE.md`, `AGENTS.md` and the like) only where you have none. Your own are never touched;
- git's `pre-push` hook, so every tool and your terminal go through the same gate;
- semantic search, installed once per machine (about 230 MB, shared by every Rigour version). It lets "have we learned this before?" and "is there already a helper for this?" work by meaning. Skip it with `rigour setup --no-semantic`.

It ends by checking that each piece works.

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

This removes Rigour's hook entries and MCP server from your configs (everything else in them stays), the files it created that you have not edited since, and its git hook. A file it created that you have edited is kept and named. `rigour.yml` and `.rigour/` (your dismissals and backtest ledger) stay unless you add `--all`.

---

## When you want more

- **The reviewer.** A read-only review by your coding agent's own CLI that checks every point of every human review against the code. See `review.reviewer` in the [configuration](./CONFIGURATION.md).
- **Measure it on your history.** `rigour backtest` replays the review on commits your team reviewed and scores it against what they found. See [Backtest](./BACKTEST.md).
- **Watch it work.** `rigour studio`.
- [Configuration](./CONFIGURATION.md), [Agent integration](./AGENT_INTEGRATION.md), [Profiles](./PROFILES.md).
