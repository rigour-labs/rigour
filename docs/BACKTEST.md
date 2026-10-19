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

It lists merged pull requests by last update and keeps the N merged most recently. A merged pull request is updated at or after its merge, so the list is complete once its oldest update is no later than the Nth merge kept; until then it lists more, and if many old pull requests were touched after merge (backport or label bots) it stops at 32 per one asked for and warns that the result may miss recent ones.

1. **Blocks on heads the seniors approved.** Every one is a block the team would have overridden.
   This number should be about zero, and when it is not, it is said first.
2. **Points people raised in a later round that an earlier round had already blocked**, with how
   many rounds earlier. What the review would have saved the reviewer.

Then what was caught in its own round, the unadjudicated blocking findings, the cost and the time,
and any round that ran on something other than its commit's own (today's dependencies or settings,
a judge's memory). Add `--reviewer` to run the model reviewer too; without it, only the free checks
run. `--share-deps` and `--config-now` work here too.

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
- Each bulleted or numbered line in the review body, and each bold or heading block (`**1. The retry window is unbounded**`), becomes a point with no file, marked `needs`: add its `file` and `text` patterns once. The body is read as `rigour learn-reviews` reads it, so the ledger and the learner see the same points.
- `base` is the merge-base of the reviewed commit and the main branch as it was when the review was posted. A branch that merged main in is measured from the newest main it contains. When a round's base is older than that, `rigour backtest` warns: the diff would include main's own commits, and anything found on them would be scored as the branch's.
- `must_not_flag` is left empty for you to fill in.

Rounds already in the ledger with the same `id` are replaced; others are kept. The command prints how many points still need a pattern. Set `review.github_account` in `rigour.yml` (or `RIGOUR_GITHUB_ACCOUNT`) when `gh` holds several accounts.

## Running it

```bash
rigour backtest                 # every round
rigour backtest --round pr212-r2  # one round
rigour backtest --reviewer      # the reviewer too, with each round's review hidden
rigour backtest --json          # { passed, unadjudicated, rounds } as JSON
rigour backtest -c <path>       # another rigour.yml (read at each round's commit)
rigour backtest --config-now    # today's rigour.yml for every round, not the commit's
rigour backtest --share-deps    # your checkout's node_modules for every round, not the commit's
```

Each round is checked out in one detached worktree under the git directory, `<git common dir>/rigour-backtest/checkout`, moved from round to round, so the branch you are on does not move and a backtest of many pull requests takes the disk of one checkout. Run one backtest at a time per repository. The worktree is reused on the next run. The score and every finding reported are written to `.rigour/backtest/<round>-<commit>.json` (not committed), so a pattern that missed can be checked against what was actually reported.

```
pr212-r2 at 3f9c2a1d: pass (1 unadjudicated); 3/3 caught, 0 false block(s), 1 unadjudicated, 12 finding(s), 15s; caught by unbounded-window 2, reviewer:claude 1
  caught  R2-1 the checkout link drops the currency (reviewer:claude src/lib/checkout.ts:18)
  caught  R2-2 the export reads every line item (unbounded-window src/lib/server/invoices.ts:41)
  caught  R2-3 quadratic scan in latestPayment (unbounded-window src/lib/server/payments.ts:12)
  config: the commit's rigour.yml
  dependencies: the commit's, installed from its lockfile (cache 5be1c0d2a7f3e914)
  lessons as of 2026-04-12T12:00:00.000Z (reviewed_at): 14 served, 3 learned later left out, 0 with no timestamp left out
1 unadjudicated blocking finding(s): they match no point and no must_not_flag row, so they were not scored either way (neither a catch nor a false block).
```

A false block is listed on a `FALSE` line with the check, file and line. When the reviewer ran and gave no verdict, the round shows `NO VERDICT` and the reason. Each round says `pass`, `pass (N unadjudicated)` or `fail` (see [Unadjudicated findings](#unadjudicated-findings)), then what it ran with (see [What a round holds fixed to its time](#what-a-round-holds-fixed-to-its-time)).

### What a round holds fixed to its time

A round replays the review as it could have run when the person reviewed. Besides the code at the commit, these are held to the round's moment: its `reviewed_at`, or the commit's own time when the round has none (the report says which).

| What | In a round | What the report says |
| --- | --- | --- |
| Settings | The `rigour.yml` at the commit (or the file `-c` names, read at the commit); Rigour's defaults when the commit has none. `--config-now` uses today's. If the commit's file does not parse, today's is used | `config: the commit's rigour.yml`, `the defaults (the commit has no rigour.yml)`, or `today's rigour.yml, not the commit's (…)` |
| Dependencies | When the commit's lockfile is byte for byte your checkout's, your `node_modules` is the commit's and is linked in. Otherwise the commit's lockfile is installed, frozen, offline first and with no install scripts, with the package manager its lockfile belongs to, into `<git common dir>/rigour-backtest/deps/<lockfile hash>/`; rounds with the same lockfile reuse it, and only the three used last are kept. When the install fails, the commit has no lockfile, or you pass `--share-deps`, the round runs on your checkout's `node_modules` | `dependencies: the commit's (…)`, or `dependencies: today's, not the commit's (why)`. Never silently |
| Lessons | Only lessons created at or before the moment, with only their evidence from then: a later acceptance, rewording or scoping is left out and the lesson's state, wording and reach are worked out from what is left. A lesson with no creation time is left out and counted | `lessons as of <time>: N served, N learned later left out, N with no timestamp left out` |
| `RIGOUR_REVIEW_LESSONS` | Not read: the round reads only the lessons store at the commit | `RIGOUR_REVIEW_LESSONS (…) is set and ignored` |
| Team decisions | A teammate's decision (team mode) counts only when it was decided before the moment | `N team decision(s) made later left out` |
| Judges (`--reviewer`) | codex runs in a Codex home of its own holding only your login, so your Codex memories, `config.toml` and `AGENTS.md` stay out (a profile with its own Codex home keeps it). `claude` already runs with no CLAUDE.md and no auto-memory. `cursor-agent` has no switch to keep your Cursor rules out | `judge memory not isolated: <judge>: <what it read>`, from the review's own record |
| Human reviews and the description | Hidden from `reviewed_at` on, and the description as it read then (see the ledger) | The `reviews hidden from` line |

What is not held to the commit's time: the Rigour version and its checks (today's Rigour reviews the past code), and the agent CLIs and the models behind them. A round reads lessons only from the commit's own `.rigour/review-lessons.json`, which exists when a team commits that file; a clone's own lessons, which `rigour init` keeps out of git, are not read by a round at all.

A point counts as **caught** only when a blocking finding matches it. A match in an advisory note or a context finding is shown as **noted** and still counted as missed, because nothing advisory stops a push. With `--reviewer`, the reviewer's confirmed items count as blocking; its unverified items, notes and disputed items count as advisory.

### Unadjudicated findings

A blocking finding that matches no point and no `must_not_flag` row is **unadjudicated**: no person said whether it was right, so it is scored neither as a catch nor as a false block. Each round counts them, the summary gives the total and says they were not scored, and the JSON carries `unadjudicated` on each round and in total. The pass rule is unchanged, but a round that passes with unadjudicated findings says `pass (N unadjudicated)`, never a plain `pass`: a reviewer that blocks on everything would catch every point, and the count is where that shows. To score them, add the code a person called good to `must_not_flag`, or a point for what they would have raised.

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

The score is on your own history, not a benchmark: the reviewer's points are the standard, so the ledger says what your team's reviews would have been spared. It measures recall against points people made and false blocks on code they approved. It does not measure findings no one wrote down: a blocking finding that matches no point and no `must_not_flag` row is counted as unadjudicated and scored neither way.

Keep the rounds of every reviewed pull request you care about, and judge a rule by its rows rather than by what it should catch.
