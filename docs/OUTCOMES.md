# Outcomes

A review is a prediction: this code is fine, or this point matters. What happens after the merge says whether it was right. Rigour keeps one record of that per merged pull request, and its learning reads those records as evidence. It is off until a team or a person turns it on.

## What a record holds

| Field | What it is |
|:---|:---|
| `files` | What the merge changed on main (its first-parent diff). |
| `ci` | The check runs on the merge commit: `success`, `failure` (any run failed or timed out), `pending` (one still running), `none` (no runs, or only cancelled and skipped ones), or `unavailable` (GitHub could not say). |
| `followUps` | The later commits on main's first-parent history that touched those files, within the window, oldest first: each with its subject, the files it touched, and `fix` when its subject says it fixed something ("fix", "bug", "hotfix", "regression", "revert", "broke"). |
| `reverted` | The commit that reverted the pull request: a subject starting "Revert" that names its number or its merge commit. |
| `windowEnd`, `settled` | The window runs from the merge for `learning.outcomes.window_days` (default 30, from 7 to 90). Once it has closed and CI has an answer (`success`, `failure` or `none`), the record is settled: it never changes and is never read again. |

Follow-ups are read by file on main's first-parent history, so a merge commit and a squash merge read the same.

A record is evidence, not a verdict. A commit that says "fix typo" touches a file as much as a real fix does, and a CI failure can be a flaky test. After each run, `rigour outcomes` reads every record it keeps against the team's review lessons:

- for a point its pull request left alone, a later fix inside the window that changed the point's own lines (within three either side, followed as the code moves, touching at most fifteen files) is an `outcome` and promotes the lesson, with CI regressing or a revert recorded as context; a fix elsewhere in the point's file is `followup` evidence, never enough;
- a later pull request that a review found repeating a lesson (`lessons_applied` on the [thread](THREAD.md)), merged anyway and settled clean, is `against` it; `learning.outcomes.demote_after` of those, independent, take back a lesson an outcome or recurrence promoted.

The rules, and what is never taken back, are in [REVIEWER.md](REVIEWER.md#how-it-learns). The lessons file is written only when something changed.

## Reading them

```bash
rigour outcomes                # the last 20 merged pull requests
rigour outcomes --last 50
rigour outcomes --pr 42
rigour outcomes --json
```

Records are kept in `.rigour/outcomes.json`, keyed by merge commit. A settled one costs nothing to read again. Anything else costs one `gh api` call for its check runs and a `git log` of its files, bounded at both ends by the window. A run stops after two minutes and says how far it got; the next run carries on.

When this machine worked on the pull request's branch, its [thread](THREAD.md) gets a `merge` event the first time the record is read and an `outcome` event when it settles.

## Turning it on

Four layers, the nearest wins, as for the [goal check](GOAL.md):

| Layer | How |
|:---|:---|
| This run | `rigour outcomes --outcomes` or `--no-outcomes` |
| Environment | `RIGOUR_OUTCOMES=on` or `off` |
| You | `"outcomes": true` or `false` in your profile's `settings.json` |
| The team | `learning.outcomes.mode: off \| on \| required` in rigour.yml (default `off`) |

`required` is the team's floor: a nearer layer that turns it off is refused, and the refusal is reported. In Studio, **Setup** shows it and lets you change yours and the team's.

## Run it after every merge

Outcomes are read when someone runs `rigour outcomes`. To read them as merges land, run the same command from CI on pushes to main:

```yaml
on:
  push:
    branches: [main]
jobs:
  outcomes:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - run: npx -y @rigour-labs/cli outcomes --outcomes
        env: { GH_TOKEN: "${{ github.token }}" }
```

With the outcome loop off, the command reads nothing, says so, and exits 0, so the step stays green for a team that has not turned it on. The records then live in that job's checkout: commit `.rigour/outcomes.json` from the job, or cache it, to keep them between runs.
