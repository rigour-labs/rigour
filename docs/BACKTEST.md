# Backtest: measured against your own reviewers

`rigour backtest` answers one question with a number: of the points a person made reviewing a pull request in this repository, how many would Rigour have caught before them, and would it have blocked anything they called good?

It runs the review on a commit someone reviewed, with that review hidden, and scores what Rigour reports against the review.

The backtest is a measurement, not a required check. No hook, push gate or CI step runs it; you run it when you want the number, for example before and after changing a rule or a reviewer setting. Its exit code is there so you can make it a gate in your own CI if you choose to.

## Start here: `rigour backtest --last N`

The front door. It takes the last N merged pull requests of this repository, builds the ledger on
its own (one round per review by a person, from the inline comments; plus the head a person
approved, with no points), runs the review on each round with that review hidden (an approved head
keeps its approval: it closes the points raised before it), and reports the
two numbers a team needs before trusting a reviewer:

1. **Blocks on heads the seniors approved.** Every one is a block the team would have overridden.
   This number should be about zero, and when it is not, it is said first.
2. **Points people raised in a later round that an earlier round had already blocked**, with how
   many rounds earlier. What the review would have saved the reviewer.

Then what was caught in its own round, the cost and the time. Add `--reviewer` to run the model
reviewer too; without it, only the free checks run.

```bash
rigour backtest --last 20 --reviewer
```

What it does not do: a point made in a review's body (not on a line) needs a person's pattern, so
the front door leaves it out; a round whose commit was force-pushed away is skipped and listed; the
pull requests' heads are fetched (`git fetch origin pull/<n>/head`), read-only. The ledger it built
is written to `.rigour/backtest-last.json` for a person to read and keep; nothing is sent anywhere,
and the hand-made ledger in `.rigour/backtest.json` is untouched. Exit 1 when any block landed on
an approved head.

## The ledger

The ledger is `.rigour/backtest.json`. It is shared: `rigour init` ignores `.rigour/*` in `.gitignore` but keeps `.rigour/backtest.json` (with the dismissals and `reviewed.json`) so it is committed with the repository, and `rigour uninstall` leaves it in place unless you pass `--all`. Everyone on the team scores against the same rounds.

One round per human review:

```json
{
  "rounds": [
    {
      "id": "pr212-r2",
      "commit": "3f9c2a1d",
      "base": "b7e1d0c4",
      "reviewed_at": "2026-04-12T12:00:00Z",
      "pr": 212,
      "points": [
        { "id": "R2-1", "point": "the checkout link drops the currency", "file": "checkout|total", "text": "currency" },
        { "id": "R2-2", "point": "the export reads every line item", "file": "invoices\\.ts", "lines": [30, 60] }
      ],
      "must_not_flag": [
        { "file": "session", "text": "cookie" }
      ]
    }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `id` | The round's name, used by `--round` |
| `commit` | The commit the person reviewed (at least 7 characters). It must exist in your clone; fetch the branch it was reviewed on if it does not |
| `base` | Where the reviewed commit left the main branch (their merge-base), so the round reviews only the branch's own changes, never main's |
| `reviewed_at` | Optional. With `--reviewer`, reviews and comments posted from this time on are hidden from the reviewer, and it reads the pull request description as it was at that time (from GitHub's edit history). If that version cannot be recovered, it gets no description, never today's |
| `pr` | Optional. The pull request the reviewer reads, since the round's checkout is detached. Without it, `--reviewer` reviews the commit **blind**: no human review, no description, and GitHub is never asked |
| `points` | What the person said. Each has an `id`, a `point` (the sentence, for the report) and a match |
| `must_not_flag` | Code the person called good, as matches. A blocking finding there is a false block. Optional |

A match always has a `file` pattern, a regular expression over the finding's path. It also needs a `lines` window (`[first, last]` at the reviewed commit) or a `text` pattern (a regular expression over the finding's title, details and hint), or both. The file pattern must match, and then either the finding's line falls inside the window or its text matches. Both patterns ignore case.

The ledger is checked before anything runs. A row with an empty `file`, with neither `lines` nor `text`, with a pattern that is not a valid regular expression, or still marked `needs` is listed and the run stops.

### Writing rounds from a pull request

```bash
rigour backtest init --pr 212
```

This reads the pull request's reviews through `gh` and writes one round per review by a person: not a bot, not the pull request's author, and with a body or a "changes requested" state.

- An inline comment becomes a point with its file (as an escaped pattern) and a window of 10 lines either side of its line. A comment with no line is marked `needs`.
- Each bulleted or numbered line in the review body becomes a point with no file, marked `needs`: add its `file` and `text` patterns once.
- `base` is the merge-base of the reviewed commit and the main branch as it was when the review was posted. A branch that merged main in is measured from the newest main it contains. When a round's base is older than that, `rigour backtest` warns: the diff would include main's own commits, and anything found on them would be scored as the branch's.
- `must_not_flag` is left empty for you to fill in.

Rounds already in the ledger with the same `id` are replaced; others are kept. The command prints how many points still need a pattern. Set `review.github_account` in `rigour.yml` (or `RIGOUR_GITHUB_ACCOUNT`) when `gh` holds several accounts.

## Running it

```bash
rigour backtest                 # every round
rigour backtest --round pr212-r2  # one round
rigour backtest --reviewer      # the reviewer too, with each round's review hidden
rigour backtest --json          # { passed, rounds } as JSON
rigour backtest -c <path>       # another rigour.yml
```

Each round is checked out in one detached worktree under the git directory, `<git common dir>/rigour-backtest/checkout`, moved from round to round, so the branch you are on does not move and a backtest of many pull requests takes the disk of one checkout. Run one backtest at a time per repository. The worktree is reused on the next run, and your checkout's `node_modules` is linked into it rather than installed again. The score and every finding reported are written to `.rigour/backtest/<round>-<commit>.json` (not committed), so a pattern that missed can be checked against what was actually reported.

```
pr212-r2 at 3f9c2a1d: 1/3 caught, 0 false block(s), 12 finding(s), 15s; caught by unbounded-window 1
  caught  R2-2 the export reads every line item (unbounded-window src/lib/server/invoices.ts:41)
  noted   R2-3 quadratic scan in latestPayment (advisory only)
  MISSED  R2-1 the checkout link drops the currency
```

A false block is listed on a `FALSE` line with the check, file and line. When the reviewer ran and gave no verdict, the round shows `NO VERDICT` and the reason.

A point counts as **caught** only when a blocking finding matches it. A match in an advisory note or a context finding is shown as **noted** and still counted as missed, because nothing advisory stops a push. With `--reviewer`, the reviewer's confirmed items count as blocking; its unverified items, notes and disputed items count as advisory.

| Exit code | Meaning |
| --- | --- |
| 0 | Every point in the rounds run was caught, nothing was falsely blocked, and the reviewer, if it ran, gave a verdict |
| 1 | Anything else |
| 2 | The run could not start: no ledger, an invalid ledger, an unknown round, a commit not in the repository |

### What `--reviewer` costs and needs

`--reviewer` runs the reviewer on every round, ignoring cached verdicts, with the agent CLIs the reviewer settings name (`review.reviewer` in `rigour.yml`, then your own settings). Each round is one or more agent runs, and they reach the agents' vendors. It reads the round's pull request through `gh`; a round with no `pr` is reviewed blind and makes no GitHub call. See [The reviewer](./REVIEWER.md) and [Security, privacy and network use](./SECURITY.md).

### Comparing judges

When two or more judges ran (`mode: full`, or a panel), the report adds what each judge raised on its own. An example of its shape (illustrative numbers):

```
Judges (4 round(s), 11 human point(s))
  claude: raised 6/11; 2 that no other judge raised
  codex: raised 5/11; 1 that no other judge raised
  claude and codex: kappa 0.46 over 11 point(s)
  16 agent run(s), $9.80 recorded, $1.40 per caught point
```

Kappa is Cohen's kappa over the ledger's points: agreement beyond chance on which points each judge raised. Above 0.8 the report adds that the judges share blind spots and a second one adds little. A judge whose catches the others always make too is not earning its runs. Dollars appear only when the CLIs report them, and the cost per caught point divides by every point caught in those rounds, by any check or judge.

To decide whether `escalate: risk` is safe, run the same rounds with it and with `escalate: always`, and compare: switch only if no point the always-on panel caught goes missing.

## What the number means

The score is on your own history, not a benchmark: the reviewer's points are the standard, so the ledger says what your team's reviews would have been spared. It measures recall against points people made and false blocks on code they approved. It does not measure findings no one wrote down: a finding that matches no point and no `must_not_flag` row counts for nothing either way.

Keep the rounds of every reviewed pull request you care about, and judge a rule by its rows rather than by what it should catch.
