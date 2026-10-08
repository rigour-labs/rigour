# The goal check

An agent can do good work on the wrong thing: edit a folder the task never needed, or stop before the part the ticket asked for. The goal check reads what the author said the change is for, from the pull request's description, and checks the change against it. It is deterministic (no model call), and off until a team or a person turns it on.

## What it reads

Only sections the author writes on purpose. A heading can be markdown (`## Scope`), bold (`**Scope**`) or a label alone on a line (`Scope:`).

```markdown
## Done when
- [ ] `parseGoal` reads the description
- [ ] `docs/GOAL.md` explains it
- [ ] reviewers are happy            <- prose: recorded, not checked

## Scope
- `packages/rigour-core/src/goal/`
- packages/rigour-cli/src/commands/review.ts

## Out of scope
- `packages/rigour-studio/**`

## Invariants
- a description without a goal never blocks   <- recorded, not checked
```

- **Scope** (also `In scope`, `Boundary`): the paths the change may touch, as folders, files or globs, in backticks or one bare path per bullet.
- **Out of scope** (also `Not in scope`): paths it must not touch.
- **Done when**: a checklist. An item that names a file, path or symbol in backticks is checkable (a file blocks, a symbol is a note); a prose item is not.
- **Invariants**: recorded with the goal for the reviewer and later phases; not checked here.

A description without these sections declares no goal, and the check says nothing about it.

## What blocks

| Finding | Id | When |
|:---|:---|:---|
| Out of scope | `goal-scope` | A changed (or deleted) file matches an `Out of scope` path. |
| Outside the scope | `goal-scope` | The description lists a `Scope`, and a changed file matches none of it. |
| Done when, not done | `goal-done-when` | A `Done when` item names a file the change never touches. |

Both block: the author declared them, so a break is a fact, not an opinion. A `Done when` item that names a symbol (`parseGoal`, `session.leadId`) the change never touches on an added or removed line is a note, never a block: an item can state a property the change keeps ("`isCronRequest` is still the only Bearer check"). A backticked token is a file only when it has a `/`, a glob, or a known file extension, so member access such as `JSON.parse` is a symbol.

Tests (`*.test.*`, `*.spec.*`, files under `test/`, `tests/`, `spec/`, `__tests__/`), snapshots (`__snapshots__/`, `*.snap`), lockfiles, changelogs (`CHANGELOG.md` and the like) and release notes (`releases/*.md`) never count as outside the scope: they follow the code they belong to. A file a `Done when` item names is part of the goal, whatever `Scope` lists. A finding can be dismissed like any other (`rigour dismiss <key>`).

The fix is one of two: move the change, or correct the description. A goal that changed is fine; a description that no longer says what the change does is what a human reviewer would have caught.

## Turning it on

Four layers, the nearest wins, as for the [reviewer](REVIEWER.md):

| Layer | How |
|:---|:---|
| This run | `rigour review --goal` or `--no-goal` |
| Environment | `RIGOUR_GOAL=on` or `off` (hooks and CI take no flags) |
| You | `"goal": true` or `false` in your profile's `settings.json` |
| The team | `review.goal: off \| on \| required` in rigour.yml (default `off`) |

`required` is the team's floor: a nearer layer that turns the check off is refused, and the refusal is reported, never silent.

## Where the description comes from

The check runs in `rigour review` (and so in CI). The stop hook and the push gate do not read a description yet.

`rigour review --pr-body <file>`, or, in a pull request's GitHub Actions job, the pull request in the event (`GITHUB_EVENT_PATH`). With the check on and no description, the review runs without it and says why in its JSON (`goal.reason`).

## In the JSON

`rigour review --json` carries a `goal` record: whether the check was on and which layer decided (`enabled`, `source`, `required`), any `refused` choices, whether the description `declared` anything checkable, the `scope` and `out_of_scope` it read and how many `done_when` items, and a `reason` when a check that was on checked nothing. The report's summary names `goal` as PASS or FAIL when it ran.
