# The reviewer: from one judge to a panel

The reviewer is a second opinion on a branch, before a person reviews it. It runs your coding
agents' own CLIs (Claude Code, Cursor, Codex) headless and read-only, with their logins: no API
key. It reads every human review on the pull request and checks each point against the code, then
reviews the change itself.

It is **off by default**, and every part of it is a choice: your team's, in `rigour.yml`, or yours,
for your own runs. Start with one judge; add more when the backtest says they earn their cost.

## Three ways to run it

| Mode | Judges | When it fits |
| --- | --- | --- |
| `single` (default) | one | Most changes. Cheapest. |
| `cross` | one, from a vendor that did not write the code | When an agent wrote the change: its own model reviewing itself shares its blind spots. |
| `full` | one per vendor, up to `judges` (2 or 3) | The step before asking a person to review. Findings are merged. |
| `full` + `panel` | one per vendor, up to `judges` (2 or 3) | When noise matters as much as recall: only what most judges agree on blocks. |

A judge from another vendor matters because two runs of the same model share blind spots. Rigour
picks one judge per vendor, in the order of `reviewers`, so a panel of three needs three vendors
installed. With fewer than asked, the review runs with what there is and **says so**: the verdict
records what was asked, what ran and why. A team can make the panel required, and then a review
without enough vendors is *unavailable*, which blocks like any review that could not run, instead
of quietly running with one judge.

## How the panel agrees

The panel never trusts one model's word, and it does not pay to ask every question twice.

1. **Every judge reviews blind**, in parallel, from the same inputs.
2. **Their findings are matched.** Two findings are the same when they name the same file and are
   close in wording, line and class. The matching is an optimal one-to-one assignment (the
   Hungarian algorithm), not first come first served, so two different bugs on adjacent lines stay
   two and one bug cited at different lines stays one. When one judge names two things another
   judge wrote as one finding, they are grouped together.
3. **A finding most judges raised is confirmed.** No more model calls.
4. **Everything else is cross-examined, once.** Each judge gets one batched question about the
   findings it did not raise: confirm or refute, quoting the code (`file:line`). An answer whose
   `file:line` is not in your checkout counts as unsure.
5. **The majority decides.** Confirmed: a strict majority raised it or confirmed it with evidence.
   Dropped: refuted with evidence at least as often as it was supported, and every judge answered,
   none unsure. Disputed: everything else.

Only confirmed findings block. Disputed ones are shown and never block. In the delta reviews of later
pushes, a finding the judges disputed is not asked about again while its file is unchanged, so a
disagreement cannot turn into an endless round; a full review (`--full`) asks again.

**An opinion never blocks.** Every finding must name its consequence: the wrong outcome it causes
(an input and what goes wrong) or the cost it adds (reads, calls or memory per what). A finding
whose judge says it has none (only "faster, simpler or cleaner") is a note, however many judges
agree. A finding that leaves the field out entirely still blocks: a judge's slip never quietly
passes a change.

Every finding keeps who raised it, each judge's call, the cross-examination and its class, so the
panel can later be re-scored against what your reviewers actually found without running anyone
again.

## Who controls it

The nearest choice wins:

1. a flag on this run: `--full`, `--single`, `--panel`, `--no-panel`;
2. the environment, for hooks and CI that take no flags: `RIGOUR_REVIEWER_MODE`, `RIGOUR_REVIEWER_PANEL`;
3. **yours**: the `reviewer` block in the settings of your Rigour home, or Studio's Setup page;
4. **your team's**: `review.reviewer` in `rigour.yml` (Rigour's defaults when there is none).

Your own settings apply to your runs in every repository on your machine. The team can set a
**floor** that no nearer choice goes below: `panel: required` and `mode_required: true`. Under a
floor, no one can turn the reviewer off, lower `judges` or set `escalate: risk`. A choice the floor
refuses is reported, never silently ignored, and so is an environment value Rigour does not
understand. A panel needs two vendors, so it makes the mode `full`; asking for one judge at a nearer
layer than the panel's turns the panel off, unless the team requires it.

```yaml
review:
  reviewer:
    enabled: true
    reviewers: [claude, codex, cursor]
    mode: full
    panel: on          # off | on | required
    judges: 3          # 2 or 3, one per vendor
    escalate: risk     # always | risk
    cross_models: { claude: claude-haiku-4-5 }   # a cheaper model for cross-examination
```

In Studio, **Setup** shows the reviewer's main settings as what runs, yours and the team's, with where the running
value comes from. You can change yours there. You can change the team's too: Studio edits
`rigour.yml` in place, comments kept, and shows the diff for you to commit, so team policy still
reaches everyone through a reviewed change. Creating a `rigour.yml` from Studio is an explicit
step, because it turns a personal install into the team's.

## What it costs, and how it saves

- **The checks that cost nothing run first.** Judges get their results as settled facts and do
  not spend tokens on what a check already proves.
- **`escalate: risk`** adds judges only where a second opinion can change the outcome: a change
  with a risky function (the same router that scores changed functions for review), or one a
  person has reviewed. Any other change gets one judge. The `--full` step before a human review
  always gets every judge. The default is `always`, so an upgrade never changes how many judges
  you get; switch to `risk` when the backtest shows it loses nothing.
- **Cross-examination is narrow:** only findings without a majority, one call per judge, capped
  by `panel_max_items`, and it can run on a cheaper model (`cross_models`).
- **Nothing is paid for twice:** the same commit asked again with the same settings and reviews
  reuses its verdict (a dismissal still applies at once), later pushes get a delta review of the new
  commits only, and human points already settled are not judged again.
- **A push nobody will read costs nothing:** before checking anything out, the background review
  asks whether the branch has an open, ready pull request; if not, it stops and says why.

Every verdict records its agent runs and, where the CLI reports it, its cost.

## How it learns

Each judge starts from what your team already knows, written to a file it reads:

- the review lessons your team verified, and the repository's rules, for the files the change touches;
- findings the team settled: dismissed as not a bug, or refuted with evidence in an earlier round
  on a file that has not changed since. Judges are told not to raise them again without something new;
- the docs that name the changed code.

When a finding is wrong, say so once: `rigour dismiss <id> --reason "…"`, or **Not a bug** in
Studio. It never blocks again, and neither does the same finding re-worded: the same file and
class, within a few lines, in mostly the same words. A different bug nearby is never covered by
it. Every later judge is told, the background review included. Commit
`.rigour/dismissed-review-items.json` to share it with the team.

## Where you see it

- `rigour review --reviewer`: the verdict, what ran and why, and each finding with its id.
- `rigour review --status`: what the background reviewer last decided on this branch, or why its
  last review was skipped or could not run.
- Studio's **Review** page: the verdict first, then the risky functions your agent checked.
- MCP `rigour_reviewer_verdict`: the confirmed findings, for the agent doing the fixing. It never
  runs a model and never dismisses: that is a person's call.
- In a fix round, `rigour review --scope` shows what changed beyond the points the review raised.

## Measure it before you rely on it

`rigour backtest --reviewer` replays reviewed pull requests with their reviews hidden. With two or
more judges it also reports each judge's catches, what only that judge caught, how often each pair
of judges agrees (Cohen's kappa: when it is high, they share blind spots and another judge adds
little) and the cost per caught point. That is how you choose one, two or three judges, and
whether `escalate: risk` loses anything. See [Backtest](./BACKTEST.md).
