# Get started

One path, four steps, each safe to stop at. You need Node 22.13 or later and a git repository.

## 1. See what it finds, changing nothing

On a branch with work on it, in your repository:

```bash
npx @rigour-labs/cli review --base origin/main
```

This reviews what the branch changed against main. It answers in a few lines: what it reviewed, then one verdict.

```
Rigour reviewed this branch against origin/main: 10 commits, 86 files, 3 s.

✘ 2 things to fix before this is ready

  src/billing/refund.ts:42  export formatRefund is used nowhere
    → Remove the export, or use it.
    not a bug? rigour dismiss 3f9a1c2e7b4d8a60 --reason "…"

Also seen, never blocking: 4 notes (rigour review --notes)
Not shown: 15 issues the code already had before this change (review.show_preexisting: true lists them).
```

The verdict is one of three: things to fix (at most five shown, `--all` for the rest), nothing to fix in what the branch changed, or not finished, with the one command that finishes it (usually installing your dependencies so the type checks can run). Problems the code already had before the branch are counted, never listed. It writes nothing to your project except Rigour's own state folder, `.rigour/`. If what it shows is not worth your time, stop here.

## 2. Set it up

```bash
npm install -g @rigour-labs/cli     # or: brew install rigour-labs/tap/rigour
rigour setup
```

`rigour setup` is **personal** by default: nothing in your working tree, nothing to commit. It:

- switches Rigour on for this repository with a marker inside `.git/`, and adds `.rigour/` to `.git/info/exclude` (not your `.gitignore`);
- installs the agent hooks **once per machine**, for the agents installed on it (Claude Code, Cursor, Windsurf, Cline), in each one's user-level config. They are merged into what you have (your settings and own hooks stay), and each starts with a guard that stays silent in any repository you have not switched on;
- installs git's `pre-push` hook in `.git/hooks`, so every tool and your terminal go through the same gate;
- registers Rigour's MCP server at user level for Claude Code and Cursor;
- installs semantic search, once per machine (about 230 MB, shared by every Rigour version). It lets "have we learned this before?" and "is there already a helper for this?" work by meaning. Skip it with `--no-semantic`.

Settings are Rigour's defaults until you want them shared. It ends by checking that each piece works.

**For a team:** `rigour setup --team` commits Rigour to the repository instead: `rigour.yml`, the hooks of the agents the repository uses and the MCP server in `.mcp.json`, so everyone who clones gets the same gate. Configs you already have are merged into, never replaced. A repository that already commits a `rigour.yml` gets the team setup automatically. See [Team setup](./TEAM_SETUP.md).

## 3. Work as usual

Your agent edits, says it is done, pushes. Rigour speaks at three moments:

| Moment | What runs | What happens on a problem |
| --- | --- | --- |
| Every edit | Fast checks on the file | The agent sees it at once |
| Before the agent says "done" | The whole branch against main: findings to fix, code nothing uses, a merge conflict with main | The agent keeps working (at most three times) |
| Before `git push` | The same, plus your formatter, linter, type check and related tests, and what a change made redundant | The push is refused, one line per problem |

Nothing advisory blocks: a check blocks only after it has been measured on real pull requests. What to do with a finding, and which agent gets which moment: [During development](./DEVELOPMENT.md).

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

- **Pull requests.** The same review on every pull request, posted as comments, optionally a required check: [Pull requests and CI](./CI.md).
- **The reviewer.** A read-only review by your coding agents' own CLIs that checks every point of every human review against the code, from one judge up to a panel of three that blocks only on what most of them agree. Off by default; your team sets it in `rigour.yml`, you set your own in Studio's Setup page. See [The reviewer](./REVIEWER.md).
- **Keep a fix round to what the review asked.** `rigour review --scope` lists the files the branch changed since the latest human review on its pull request that no point of that review cited, by an inline comment or by naming the file. Merges from main are not counted, and a test beside a cited file is in scope. It exits 1 when there are such files. `--scope-review <id>` measures from an earlier review.
- **Measure it on your history.** `rigour backtest` replays the review on commits your team reviewed and scores it against what they found. See [Backtest](./BACKTEST.md).
- **Watch it work.** `rigour studio`.
- [Configuration](./CONFIGURATION.md), [Coding agents and MCP](./AGENTS.md), [Security and network use](./SECURITY.md), [Profiles](./PROFILES.md).
