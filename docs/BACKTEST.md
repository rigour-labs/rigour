# Backtest: measured against your own reviewers

`rigour backtest` answers one question with a number: of the points a person made reviewing
a pull request in this repository, how many would Rigour have caught before them, and would it
have blocked anything they called good?

It runs the review on a commit someone reviewed, with that review hidden, and scores what Rigour
reports against the review. The score is the acceptance test for every rule: a check is only as
good as its ledger row, and a rule change that lowers the score does not ship.

## The ledger

`.rigour/backtest.json`, committed with the repository. One round per human review:

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

- `commit`: the commit the person reviewed. `base`: the main branch as it was then (a later merge
  must not change what the round measures). `reviewed_at`: from then on, reviews and comments are
  hidden from the reviewer.
- A point is a `file` pattern (a regular expression over the finding's path) plus a `lines` window
  at that commit, or a `text` pattern over the finding's words, or both: either one is enough. A
  row with neither is rejected before anything runs.
- `must_not_flag` lists code the person called good, in the same shape. A blocking finding there is
  a false block.

`rigour backtest init --pr <number>` writes the rounds from a pull request's human reviews. An
inline comment gives its point a file and a line window for free. A point made in the review's
body has no line, so it is written with `needs` set, and someone adds its pattern once.

## Running it

```bash
rigour backtest              # every round
rigour backtest --round r5   # one round
rigour backtest --reviewer   # the reviewer too, with each round's review hidden
rigour backtest --json
```

Each round is checked out in a detached worktree under the git directory (`.git/rigour-backtest/`),
so the branch you are on does not move. The score and every finding reported are written to
`.rigour/backtest/<round>-<commit>.json`, so a pattern that missed can be checked against what was
actually there.

```
pr212-r2 at 3f9c2a1d: 1/3 caught, 0 false block(s), 12 finding(s), 15s
  caught  R2-2 the export reads every line item (unbounded-window src/lib/server/invoices.ts:41)
  noted   R2-3 quadratic scan in latestPayment (advisory only)
  MISSED  R2-1 the checkout link drops the currency
```

A point counts as **caught** only when a blocking finding matches it. A match in an advisory note
is shown as **noted** and still counted as missed, because nothing advisory stops a push. The
command exits 1 until every point is caught with no false block, and when the reviewer ran and
gave no verdict.

With two or three judges (`mode: full`, or a panel), the report adds what each judge did on its own. An example of its shape (illustrative numbers):

```
Judges (4 round(s), 11 human point(s))
  claude: raised 6/11; 2 that no other judge raised
  codex: raised 5/11; 1 that no other judge raised
  claude and codex: kappa 0.46 over 11 point(s)
  16 agent run(s), $9.80 recorded, $1.40 per caught point
```

Kappa is agreement beyond chance on the ledger's own points. Near 1, the judges share blind spots
and another one adds little; a judge whose catches the others always make too is not earning its
runs. Run the same rounds with `escalate: risk` and compare: it is safe to switch only if no point
the always-on panel caught goes missing. See [The reviewer](./REVIEWER.md).

## What the number means

The score is on your own history, not a benchmark: the reviewer's points are the standard, so the
ledger says what your team's reviews would have been spared. Keep the rounds of every reviewed PR
you care about; a rule is retired or promoted on what the rows say, not on what it should catch.
