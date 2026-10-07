# Team setup

How to give everyone who works on a repository the same Rigour: the same checks, the same reviewer, the
same record of what was judged not a bug. For trying Rigour on your own first, see
[Get started](./QUICK_START.md).

## Personal or team

| | Personal (`rigour setup`) | Team (`rigour setup --team`) |
| --- | --- | --- |
| In your working tree | Nothing | `rigour.yml`, the agents' project hooks, the MCP server config |
| Who it applies to | You, in the repositories you switch on | Everyone who clones the repository |
| Settings | Rigour's defaults, plus your own | The committed `rigour.yml`, plus each person's own where the team allows |
| Typical use | Trying Rigour; a repository that is not yours | A team that has decided to use it |

A repository that already commits a `rigour.yml` is set up as a team repository automatically.

## Set it up for the team

One person, once, on a branch:

```bash
rigour setup --team
```

This writes, for you to commit:

| File | What it is |
| --- | --- |
| `rigour.yml` | The team's settings. Start with the defaults; see [Configuration](./CONFIGURATION.md). |
| Each agent's project hooks | After every edit, before "done" and before a push, as each agent supports ([which agent gets which](./DEVELOPMENT.md#which-agent-gets-which-moment)). Written for the agents the repository shows signs of (a `.claude`, `.cursor`, `.windsurf` or `.clinerules` folder, a `.windsurfrules` file or a `CLAUDE.md`), Claude Code when there are none: `.claude/settings.json`, `.cursor/hooks.json`, `.windsurf/hooks.json`, `.clinerules/hooks/`. Merged into what is there; your other settings stay. |
| `.mcp.json`, `.cursor/mcp.json` | Rigour's MCP server for Claude Code and Cursor, so agents can ask Rigour for review tasks, lessons and existing helpers. |
| `.gitignore` lines | Keep Rigour's local state out of git, except the files a team shares (below). |

To add an agent later, run `rigour hooks init --tool cursor` (or `cline`, `windsurf`, `all`) and commit what it writes.

Agent instructions are optional: the MCP tools describe themselves and the hooks enforce. With
`rigour setup --team --instructions`, Rigour writes one `AGENTS.md` (the file most coding agents read) and a
one-line `CLAUDE.md` that points Claude Code at it, only where you have none. Where you do, it tells you
what to add.

Open a pull request with these files like any other change.

## Every teammate, once per clone

```bash
rigour setup
```

It sees the committed `rigour.yml`, completes the team install on that machine, and adds git's
`pre-push` hook to the clone. That hook lives in `.git/hooks`, which a clone does not carry, so each
person runs this once. `rigour doctor` confirms everything is wired up.

If the repository keeps its git hooks in the working tree (Husky's `.husky/`), team setup adds Rigour's
line to the `pre-push` hook there, for you to commit once. A hooks directory outside the repository is
left alone, and setup prints the one line to add to it.

## What to commit, and why

Some of Rigour's state is a team decision and belongs in the repository. The `.gitignore` lines setup
adds keep everything else local.

| File | Commit it? | Why |
| --- | --- | --- |
| `rigour.yml` | Yes | The team's settings. |
| `.rigour/dismissed.json` | Yes | Findings people judged not a bug, with the reason. Shared, so a finding dismissed once stays quiet for everyone and for the pull request bot. Reviewed like code. |
| `.rigour/dismissed-review-items.json` | Yes, if your team allows reviewer dismissals | The same for the model reviewer's findings, with who dismissed each. |
| `.rigour/reviewed.json` | Yes, if you use the pull request bot | Risky functions already reviewed before the pull request (hashes and verdicts only), so the bot does not pay to review them again. Written by `rigour review-export`. |
| `.rigour/backtest.json` | Yes, if you measure Rigour | Your team's own review points, used to score Rigour ([Backtest](./BACKTEST.md)). |
| Everything else in `.rigour/` | No | Local caches, logs and per-person state. |
| `rigour-report.json`, `rigour-fix-packet.json` | No | Per-run output. |

## Team decisions in `rigour.yml`

Most teams change very little. These are the settings a team usually decides together:

| Decide | Setting | See |
| --- | --- | --- |
| Your own lint, type check and test commands, if the defaults are not right | `commands` | [Configuration](./CONFIGURATION.md#commands) |
| Paths no check should look at | `ignore` | [Configuration](./CONFIGURATION.md) |
| Exports or files a framework loads by name, so they are not reported as unused | `gates.unused_exports.allow`, `gates.orphan_files.allow` | [Configuration](./CONFIGURATION.md) |
| Where your database migrations live, for the schema-aware checks | `gates.redundancy.schema_migrations`, `gates.migration_order` | [Configuration](./CONFIGURATION.md) |
| Whether to run the model reviewer, and how many judges | `review.reviewer` | [The reviewer](./REVIEWER.md) |
| A daily cap on what the reviewer may spend | `review.reviewer.max_runs_per_day`, `max_usd_per_day` | [The reviewer](./REVIEWER.md#what-it-costs-and-how-it-saves) |
| Whether people may dismiss the reviewer's findings | `review.reviewer.dismissals` | [The reviewer](./REVIEWER.md#how-it-learns) |

### Team settings and personal settings

Each person can choose some things for their own runs (for example the reviewer on or off, or a lower
daily cap), in Studio's Setup page or in their own Rigour settings. A personal choice applies in every
repository on that person's machine.

The team can set floors no personal choice goes below:

- `review.reviewer.panel: required` or `review.reviewer.mode_required: true`: no person or run may review
  with fewer judges, turn the reviewer off, or add judges only for risky changes.
- `review.reviewer.dismissals`: only the team decides whether the reviewer's findings can be dismissed.
- Caps: a person can set a lower daily cap, never a higher one.

A choice a floor refuses is reported, never silently ignored.

## Pull requests

Add the pull request bot as a CI check so every pull request gets the same review, including ones from
people who have not run `rigour setup`. See [CI](./CI.md).

## People who work for several organizations

A contractor or consultant can keep each employer's Rigour state, team and settings apart on one
machine, chosen automatically by repository. See [Profiles](./PROFILES.md).

## Sharing what agents learn

By default, everything Rigour learns stays on the machine that learned it. A team can point Rigour at a
shared PostgreSQL database so that a lesson one person's agent learns, once someone approves it, reaches
everyone's agents. Only lessons from the repositories you name are sent. See
[Team database](./TEAM_DATABASE.md).

## Taking it back out

```bash
rigour uninstall --all
```

Removes Rigour's hook entries and MCP server from the committed configs (everything else in them
stays), the files it created that nobody has edited since, its git hook, `rigour.yml`, `.rigour/` and
its `.gitignore` lines. Commit the result. A file Rigour created that someone has since edited is kept
and named.
