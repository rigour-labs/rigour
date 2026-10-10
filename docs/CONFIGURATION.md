# Configuration

How Rigour is configured, which settings teams actually change, and how a team's settings and a
person's combine. Every setting, with its default, is in the [Configuration reference](./CONFIG_REFERENCE.md).

## Where settings live

| Where | Who it is for | How you change it |
| --- | --- | --- |
| `rigour.yml` at the repository root | The team. Committed and reviewed like code. | Edit the file. The reviewer's team settings can also be edited in Studio's Setup page, which changes the file in place, keeps its comments and shows the diff to commit. |
| Your own settings: `settings.json` in your Rigour home (`~/.rigour`, or the home of the [profile](./PROFILES.md) the repository uses) | You, in every repository on this machine: model keys and your reviewer choices. | `rigour settings set-key <provider> <key>`, `rigour settings set <key> <value>`, or your settings in Studio's Setup page. |
| Flags and environment variables | One run, or a hook or CI job that takes no flags. | See [Environment variables](#environment-variables). |

You do not need a `rigour.yml`. Without one, every check runs with its defaults, which are chosen to report
only what Rigour can show is wrong. `rigour setup --team` writes one, so the team has a file to change
when it needs to.

## What teams usually change

Most teams change three or four settings. These are the common ones.

### Commands

```yaml
commands:
  lint: pnpm lint
  typecheck: pnpm typecheck
  test: pnpm test:changed
```

Before a push, Rigour runs the project's own formatter, linter, type check and the tests that import
changed files, finding them in `node_modules`: Prettier, ESLint, the `typecheck` or `check` script (else
svelte-check or tsc), and `vitest related`. Name a command here when that is not what your team runs. It
replaces the tool Rigour would have found, runs on the whole project as written, and blocks the push when it
fails. Commands run without a shell, so `&&` and pipes are not interpreted: point at a package script.

Rigour never downloads a tool. A tool the project never declared is skipped and said so; one declared in
`package.json` but not installed fails, because a checkout without its dependencies cannot prove anything.

### Paths to skip

```yaml
ignore:
  - "generated/**"
  - "legacy/**"
```

Every check, review and agent hook skips these, on top of the paths always skipped: `node_modules`,
`dist`, `studio-dist`, `.next`, `coverage`, `out`, `target`, `examples`, `.git`, the npm and pnpm lock
files and `rigour-report.json`.

### Names a framework loads by name

```yaml
gates:
  unused_exports:
    allow: [register, handler]     # exports a tool loads by name
  orphan_files:
    allow: ["scripts/one-off/**"]  # files a tool loads by path
```

Rigour reports an export nothing imports, and a new file nothing imports or runs. It already knows the
common conventions (route modules, tests, migrations, config files); list what your tooling loads that it
cannot see. Both are notes until the team sets `block: true` under `unused_exports` or `orphan_files`; then they
block like any proven finding.

### Database migrations

```yaml
gates:
  redundancy:
    schema_migrations: ["supabase/migrations"]   # the SQL migrations, to learn which columns are NOT NULL
  migration_order:
    enabled: true
    dirs: ["**/supabase/migrations"]             # a migration added before the newest one blocks
```

### Turning a check off

```yaml
gates:
  context_window_artifacts:
    enabled: false
```

Every check has `enabled`. Before turning one off because of a wrong finding, dismiss the finding instead
(`rigour dismiss <key> --reason "…"`): the dismissal is recorded, and an advisory check whose findings a team
keeps dismissing goes quiet on its own. `rigour precision` shows which checks those are.

### What a review shows

```yaml
review:
  show_preexisting: false     # true also lists problems the code had before the change
  include_heuristics: false   # true lets size, complexity and similar judgement calls block
```

The defaults are what most teams want: a review lists only what the change introduced, and blocks only on
what Rigour can show is wrong ([What blocks](./DEVELOPMENT.md#what-blocks-and-what-does-not)).

### The reviewer

Whether to run the reviewer, how many judges, the daily caps and whether people may dismiss its findings
are under `review.reviewer`. See [The reviewer](./REVIEWER.md).

## Team settings and personal settings

For the checks, `rigour.yml` is the only source: a person cannot change what the team's checks do.

The reviewer is the exception, because it runs each person's own agent CLIs on their machine. For it, the
nearest choice wins: a flag on this run, then an environment variable, then the person's own settings, then
`rigour.yml`. The team can set floors no nearer choice goes below (`review.reviewer.panel: required`,
`mode_required`), and some settings only the team can set (`dismissals`, `on_push`, `timeout_ms`,
`panel_max_items`, `cross_models`, `judge_env`). A person can set a lower daily cap, never a higher one. Studio's Setup
page shows, for each setting, what runs, yours and the team's, and where the running value comes from.

[Model review](./MODEL_REVIEW.md) with an API key is chosen per run, by flags or your own settings. The
key, provider and model are never read from `rigour.yml`, so a committed file cannot carry a secret or
switch on paid calls for everyone.

## A branch cannot loosen its own review

A change can edit `rigour.yml` or `.rigour/dismissed.json` as easily as code. When a review is enforcing,
as in a required pull request check, run it with `--independent`:

```bash
rigour review --base origin/main --independent
```

It reads `rigour.yml`, the dismissals and the record of past findings as they are on the base, not as the
branch left them, and counts no review an agent recorded for itself. `rigour review` also names any change
the branch makes to Rigour's own settings, so a person reviewing it sees that. See
[Pull requests and CI](./CI.md).

## Templates

`rigour setup --team` and `rigour init` look at the repository and start `rigour.yml` from a template: a
role (`ui`, `api`, `infra`, `data`, `healthcare`, `fintech`, `government`, `devsecops`) and a coding style
(`oop`, `functional`). A template only sets starting values, such as tighter structure limits or a stricter
security threshold. The file it writes is yours to edit. To choose one yourself:

```bash
rigour init --preset api --paradigm functional --force
```

`--force` replaces an existing `rigour.yml` and keeps a backup of it.

## Environment variables

| Variable | What it does |
| --- | --- |
| `RIGOUR_HOME` | The folder Rigour keeps its state under (in `$RIGOUR_HOME/.rigour`), instead of your home or a profile's. A value ending in `.rigour` is the state folder itself; state an earlier version wrote one level deeper (`$RIGOUR_HOME/.rigour`) stays in use, and `rigour doctor` says how to move it. Set it yourself and no [profile](./PROFILES.md) applies to that run, so an isolated run stays isolated; agent CLIs the reviewer runs still use your real home and logins. |
| `RIGOUR_API_KEY` | The key for [model review](./MODEL_REVIEW.md) when no `--api-key` is given. |
| `RIGOUR_REVIEWER_MODE`, `RIGOUR_REVIEWER_PANEL` | The reviewer's mode (`single`, `cross`, `full`) and panel (`on`, `off`), for runs that take no flags. |
| `RIGOUR_GITHUB_ACCOUNT` | The `gh` account whose token reads pull requests and their reviews. `GH_TOKEN` wins when set. When GitHub answers 401, 403 or 404, `rigour learn-reviews` names the account (or the variable) it read as, never the token, since with several accounts that usually means this one cannot see the repository. |
| `RIGOUR_REVIEWER_BLIND` | `1`: the reviewer reviews the change alone, with no pull request lookup, description or human reviews, as `--blind` does (no GitHub CLI needed). |
| `RIGOUR_MCP_TOOLS` | `governance` adds the agent-team tools to the MCP server ([Coding agents and MCP](./AGENTS.md)). |
| `RIGOUR_CWD` | The repository the MCP server works in when the agent does not say. |
| `RIGOUR_USER_MEMORY` | `off` keeps the MCP server from writing lessons to your home folder. |
| `RIGOUR_UPDATE_CHECK` | `0` turns off the daily check for a newer version. `DO_NOT_TRACK=1` does too. |

The team database has its own variables; see [Team database](./TEAM_DATABASE.md).

## When the file is wrong

`rigour.yml` is validated every time it is read. A value of the wrong type stops the run with an error that
names the setting. A setting Rigour does not know is ignored, so a file written for an older or newer version
still loads.
