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

- for a point its pull request left alone, a later fix inside the window that changed the point's own lines (within three either side, followed as the code moves, touching at most fifteen files) is `lines` evidence, with CI regressing or a revert recorded as context; a fix elsewhere in the point's file is `followup`. Neither promotes a lesson: Studio shows them on the candidate for a person to promote or dismiss ([REVIEWER.md](REVIEWER.md#how-it-learns) says why);
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

## Numbers

`rigour outcomes` prints them, `rigour outcomes --json` carries them as `metrics`, and Studio's **How it learns** shows them. All three read one function (`outcomeMetrics`), and so will anything else that reports them. Its shape is stable:

```json
{
  "version": 1,
  "records": { "merged": 0, "settled": 0, "unsettled": 0 },
  "settled": {
    "ciRegressed": { "count": 0, "of": 0, "rate": null, "reason": "fewer than 10 records: a count, not a rate" },
    "ciUnknown": 0,
    "reverted": { "count": 0, "of": 0, "rate": null },
    "fixedLater": { "count": 0, "of": 0, "rate": null },
    "reviewed": { "prs": 0, "fixedLater": { "count": 0, "of": 0, "rate": null } },
    "notReviewed": { "prs": 0, "fixedLater": { "count": 0, "of": 0, "rate": null } }
  },
  "model": {
    "share": { "model": 0, "checks": 0, "prs": 0, "rate": null, "reason": "fewer than 10 pull requests: a count, not a rate" },
    "costPerPr": { "prs": 0, "totalUsd": 0, "medianUsd": null, "prsEarlierBasis": 0 }
  },
  "lessons": { "awaitingDecision": 0, "promotedFromEvidence": 0, "dismissed": 0, "takenBack": 0 }
}
```

- **Records:**
  - Everything under `settled` counts settled records only, because an open window can still change.
  - `ciRegressed` counts over settled records whose CI passed or failed. Those with no CI to read are `ciUnknown`, so they never dilute it. A record whose CI GitHub could not read never settles, so in practice `ciUnknown` counts merges that had no check runs.
  - `fixedLater` means a later commit on the pull request's files, inside the window, says it fixes something.
  - `reviewed` covers the pull requests a review by Rigour ran on (from the threads); `notReviewed` covers the rest.
- **The model reviewer**, over settled pull requests a review by Rigour ran on:
  - `share`: the model's findings (blocking and should-fix) out of all findings, the deterministic checks' included, at each pull request's first review that recorded both, before the review's own points changed the code. Below 10 such pull requests, counts only.
  - `costPerPr`: the dollars of every review round on a pull request, summed per pull request, with the total and the median. Every run counts, a failed one included: the same dollars as the review's row in the [savings ledger](REVIEWER.md#the-orchestrator). A cached verdict spent nothing. Below 10 pull requests, no median. A pull request with any review from before 6.9.0, when the dollars missed failed runs and repeated a cached verdict's, is left out and counted in `prsEarlierBasis`, never pooled: the two bases are not comparable.
- **Lessons:**
  - `awaitingDecision`: candidates waiting on a person (a later fix on their lines, back to candidate, or taken back).
  - `promotedFromEvidence`: lessons a person promoted after such evidence.
  - `takenBack`: lessons taken back and not promoted again since.
- **Rates:** a rate is given only when at least 10 records are behind it. Below that, `rate` is `null` with a reason, and Studio and the CLI show the count alone.

Read them with care:
- **Small and local.** They count only what this machine read, and a team's numbers are usually small.
- **Not a comparison.** Reviewed and not reviewed are shown side by side, never as a difference: teams choose which pull requests get reviewed, so the two groups differ, and a gap between them is not Rigour's effect.
- **Trends only.** Use them for trends within one repository over time.

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
