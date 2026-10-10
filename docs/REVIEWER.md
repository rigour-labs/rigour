# The reviewer: from one judge to a panel

The reviewer is a second opinion on a branch, before a person reviews it. It runs your coding
agents' own CLIs (Claude Code, Cursor, Codex) headless and read-only, with their logins: no API
key. It reads every human review on the pull request and checks each point against the code, then
reviews the change itself.

It is **off by default**, and every part of it is a choice: your team's, in `rigour.yml`, or yours,
for your own runs. Start with one judge; add more when the backtest says they earn their cost.

| Term | Meaning |
| --- | --- |
| Judge | One run of one agent CLI reviewing the change. |
| Vendor | Who makes the model behind a judge: Anthropic (`claude`), OpenAI (`codex`), Cursor (`cursor`), or, for the `api` judge, the maker of the model you name. Judges from different vendors have different blind spots. |
| Panel | Two or three judges from different vendors whose findings are matched, and whose disagreements are settled by evidence. |
| Cross-examination | The one follow-up question a judge is asked about findings it did not raise: confirm or refute, quoting `file:line`. |
| Floor | A setting in `rigour.yml` that no person's choice may go below. |

## What each judge checks

Every judge follows the same steps, in order, and answers in a fixed shape, so a program (not the
judge's own sense of severity) decides what blocks:

1. **Every earlier human point**, siblings included: is it fully resolved at this commit?
2. **Redundancy**: what a fix made unnecessary (a guard below a query that now filters, an optional
   member every caller supplies) and whether it was removed.
3. **Every read**: rules known before the read but applied after it, a cheaper source, keys that
   change when a user edits, unbounded windows, OFFSET paging, the index that serves it.
4. **Nested scans**: a collection scanned once per item of another.
5. **Merge impact**: call sites of main-side code the merge changed.
6. **The journey past the request**: state that outlives it (what clears it, a retry, two
   overlapping runs), a status that can move backwards or overwrite a terminal one, and event or
   dedupe keys that change when the user edits.
7. **Sibling parity**: the routes, runners or handlers that do the same job and need the same change.
8. **Claims**: every comment in a touched file and every sentence of the description that says what
   the code does, checked against the code.
9. **Team lessons**: every lesson the team taught that it was shown, answered one by one: does this
   change repeat it? A lesson pasted as background was skimmed; asked as a checklist it is checked.
10. **Repository rules**: the rules the repository wrote for itself (AGENTS.md, CLAUDE.md, Cursor rules,
    Copilot instructions, the AGENTS.md and CLAUDE.md files in folders below the root, and every file
    they import with an `@path` line; a folder's own rules, and what they import, apply only to changes
    in that folder, and rules files in vendored folders such as `vendor/` or `third_party/` are not the
    team's), the fifteen most relevant to the change, answered one by one: followed, broken,
    or not applicable, with the code that breaks one quoted. A rule the team worded as a requirement
    (must, never, always, only, every, do not), broken with its quote verified, blocks; guidance broken is a
    should-fix. The rule's words and weight come from the file, never from the judge.
11. **The diff as a person reads it.**
12. **The declared goal**, only with the [goal check](GOAL.md) on and a description that declares one: each
    "Done when" item that names no file, and each invariant, answered met, not met (with the code quoted)
    or cannot tell. An item not met is a should-fix, never a block, whatever the judge says; the
    deterministic goal check already blocks on what needs no model.

Steps 2 to 10 are the judge's working notes: you see them, and they never block on their own, with one
exception: a requirement rule shown broken with a verified quote. Otherwise only a
finding can block, and only when it carries three things: the input that goes wrong, what goes wrong
for it (or a material cost: one that grows with the data or traffic, such as an extra query, rows
read that scale with users, a missing index or an unbounded window; one more column on rows already
read, or a small duplicate check, is not), and the code that does it, quoted from the file. Rigour then checks the quote
against the checkout: the quoted code must be at the line the finding names, within a few lines. A
finding whose quote is missing or not there is shown as unverified and never blocks. That check
is mechanical, so it holds whichever model is judging. Three more rules keep a team's approved code
from being blocked:

- **Severity, by how the wrong outcome is reached.** `blocking` when it happens on the feature's normal
  path (every run, every user of it, growing with the data), even behind a flag or rollout: wrong data,
  a lost or duplicated write or event, a crash, a security hole, or a material cost. `should` when it
  needs an unusual combination of inputs or failures, is brief or cosmetic, or is a drifted comment:
  shown, never blocking. For a scheduled job, the flag-off or lock-held path is a normal path: work
  done before checking it is paid on every run.
- **A claim that something is missing names it** (`absent`), and Rigour searches the file for it: a
  finding about a call or check that is there is unverified.
- **A block sits on a line the change touched.** A finding or rule break in a touched file, verified,
  but on lines the change did not touch (or naming no line) is what the code already had: shown as a
  note, never a block on this change. A human's point is about the change by definition.
- **A human's open point blocks only where the judge quotes the code that keeps it open**, checked like a
  finding: a later commit may already have done what it asked. A point whose own reviewer approved the
  pull request after raising it is settled, with or without words in the approval, and is shown as a
  note at most: the same class coming back in later code is a finding of the judge's own, with its own
  input and consequence. A point that says something is still missing names what was searched for
  (`absent`), and Rigour searches the whole checkout for it, not only the file the point named: found
  elsewhere, the point is unverified. A point its reviewer gave as a should-fix keeps that tier: shown
  with its quote, never a block. When the review itself puts the point under a heading of its own
  ("Blocking", "Should fix", "Nits"; a bullet, a numbered line, or a numbered line set in bold), that
  label wins over the judge's reading and a disagreement is said on the item. The review is matched by
  the reviewer and the date the judge names, falling back to that reviewer's latest labelled review; the
  review record counts how many points took a label and how many the judge had read otherwise. A rule break or finding on a human point's lines in like words is that point found
  again and folds into it (the human's words stay); one in other words is a different problem and
  stays its own item; two human points never merge. And a point a human already raised and accepted as non-blocking is never escalated into a
  blocking finding.

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

### Any model, through an API

A judge does not have to be an agent CLI. Name `api` in `reviewers` and point it at any
OpenAI-compatible chat-completions API with tools (OpenAI, OpenRouter, a local server, other vendors
through a gateway):

```yaml
review:
  reviewer:
    reviewers: [api]
    api:
      url: https://openrouter.ai/api/v1   # /chat/completions is appended
      model: qwen/qwen3-coder
      key_env: RIGOUR_JUDGE_API_KEY       # the key is read from this variable, never from this file
      vendor: other                       # the model's maker, for cross and full modes; inferred from the name when unset
      max_turns: 60
    reasoning: { api: medium, codex: medium }   # reasoning effort where a judge takes one
```

Rigour runs the loop itself. The first message carries the review's inputs inline (the diff, the
human reviews, the description, the team knowledge, the hints; a very large diff is cut with a note),
so a model that never calls a tool still has what it needs; the tools (`read_file`, `search`,
`list_dir`, a read-only `git`) are for exploring beyond them, inside the checkout and the review's
own input folder. A judge that gives nothing, twice, is replaced by the next one installed in
`reviewers`, and the verdict says so; a review is unavailable only when every judge failed. The same prompt, the same evidence contract, the same
record and trace as a CLI judge; cost when the API reports it, tokens always. The judge is
installed only when `api` is configured and the key it names is set.

What we measured on the same reviews, rules frozen: Claude Code finished every review in one to
two minutes; Codex at high reasoning effort finished them four to six times slower, and ran out of
time on a large pull request; Cursor's ask mode did not finish a small review within fifteen
minutes. Set `reasoning` lower for a slow judge, and measure before you rely on any of them.

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

| Setting | Who may set it |
| --- | --- |
| `enabled`, `mode`, `panel` (on or off), `judges`, `escalate`, `reviewers`, `models`, `max_runs_per_day`, `max_usd_per_day`, `orchestrator` (on or off, see [the orchestrator](#the-orchestrator)) | The team in `rigour.yml`, and each person for their own runs |
| `panel: required`, `orchestrator: required`, `mode_required`, `dismissals`, `on_push`, `timeout_ms`, `panel_max_items`, `cross_models`, `model`, `judge_env` | The team only |

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
- **The same content is not reviewed again on another commit.** A rebase, an amend, a cherry-pick or
  the same change on another branch reuses the verdict of a full review with the same inputs (rules,
  lessons, human reviews, goal, judges and models) and the same reviewable diff, read file by file as
  before and after blobs. Before reuse, Rigour checks that the base has not moved under any file the
  verdict cites; if it has, the change is reviewed again. A reused verdict goes through the same
  quote check against the checkout and the same dismissals as a fresh one. Entries are kept for 30
  days, the newest 500.
- **A push nobody will read costs nothing:** before checking anything out, the background review
  asks whether the branch has an open, ready pull request; if not, it stops and says why.

- **Cheap-model-first, experimental and off by default** (`review.reviewer.tiers.cheap: { claude: <model> }`).
  Which model reviews a change is decided before any run, from facts about the change, never by a
  model: a required floor, human reviews, open items carried from the last verdict, a migration, a
  security finding from the checks, a declared goal, or a risky changed function gets the team's
  model; anything else gets the cheap one. The only escalation after a run is an answer that is not
  a valid verdict, retried on the team's model. What blocks is unchanged. Tiering turns itself off
  when its last 20 reviews cost more, on average, than one judge would have, and the review record
  and telemetry say so. That comparison is in dollars once Rigour has frozen a dollar
  baseline from this repository's single reviews; before that it compares characters given to the
  model, which cannot see a cheap model's lower price, only the extra runs an escalation adds. Don't rely on it until a backtest on your own history shows what the cheap
  model misses.

**Daily caps**, per repository, unset by default:

```yaml
review:
  reviewer:
    max_runs_per_day: 40     # agent runs, judges and cross-examinations alike
    max_usd_per_day: 15      # dollars the CLIs reported (Claude Code reports them; Codex reports tokens)
```

Runs are counted before any judge starts, so a review that would pass the run cap does not start,
and a cross-examination that would pass it is not made (its findings are shown as disputed, with
the cap as the reason). Dollars are known only after a run, so the cost cap stops new reviews once
today's reported spend reaches it. Past a cap, a review is skipped and says why; where the team
requires the reviewer, it is unavailable instead, which blocks like any review that could not run.
A judge whose answer is not a valid verdict (malformed or cut off) is asked once more, inside the caps;
a review with no valid verdict after that is unavailable. A person may set a lower cap for their own
runs, never a higher one. `rigour review --status` and
Studio's Setup page show today's runs and spend against the caps.

Every verdict records its agent runs, the tokens each judge used and, where the CLI reports it, its
cost. In `rigour review --reviewer --json`, `spent_usd` is what every run of this review reported
costing (a failed run, a retry, the orchestrator's fallback and cross-examinations included), and 0
for a verdict reused from the cache. `cost_usd` is the verdict's judges only, kept for compatibility:
read `spent_usd` for what a review cost. The terminal shows the same spent figure.

## The orchestrator

**Experimental, off by default.** One judge doing every step of a review spreads its attention thin.
The orchestrator routes instead: a triage step, with no model, decides which parts of the review a
change needs, and the judge is told to do only those, fully. It is a router, not a fan-out: on
average it costs no more than one judge, and a change with nothing for a model to review costs
nothing.

### What triage picks

Each hunk of the diff is read on its own:

| Part | Picked for |
| --- | --- |
| Earlier human points | every reviewable hunk, when the pull request has human reviews |
| Correctness | every file but the skipped ones, whatever its language |
| Production cost | a read (queries in TS/JS, Python, Go and SQL), a loop that awaits on every turn, or a migration |
| What the change leaves behind | a deletion, a new declaration or a new file |
| Rules, lessons and the goal | prose, comments, or any change when the team has rules, lessons or a goal for it |

Only lockfiles, snapshots, source maps, minified bundles and files a generator marks as its own
(`__generated__/`, `.generated.`, protobuf output) are skipped. Prose is matched by extension, so
code in a `docs/` folder is still code. A change made only of skipped files gets **no model run**,
and the record says "nothing for the model reviewer to review".

The five parts are fixed and versioned, so a backtest can pin them.

### One pass, split only when it pays for itself

The parts triage picked run as **one combined pass**: the same prompt and inputs as one judge,
plus a focus block and the pass's slice of the diff (its hunks, and the one hunk defining each name
they use).

A pass is held to the judge's limit: half its context window, and no more diff than its timeout
lets it read. The windows are defaults (200k tokens for the CLIs, 128k for the API judge), not
measurements; every orchestrated review records the limit it used and the judge it came from.

A split always costs more than one pass for that review, because each part re-reads the shared
inputs. So a change over the limit is split only from **savings**:

- **The savings ledger** sums, over the last 20 orchestrated reviews, what one judge would have
  been given minus what every run was given. It counts in dollars once Rigour has a baseline (the
  dollars per character of this repository's single reviews, frozen once at the first orchestrated
  review), otherwise in characters.
- **A split runs** only when the ledger covers its extra, by hunk, into at most three parts, each
  within the limit.
- **Otherwise it is one pass**, and the record says why ("over the judge's limit; ledger X, split
  needs Y: one pass", or "needs N parts > 3: one pass"). With no history the ledger is empty, so
  there is no split.

Every fresh orchestrated review writes one row to the ledger (`costs.jsonl` beside the verdicts):
what one judge would have been given, what was planned, and what every run was actually given and
reported costing, failed passes and a fallback included. A review by one judge, asked for and run,
writes the same row; those rows are what the baseline is frozen from.

### When a pass fails

- Every pass counts against the daily caps. When the caps leave one run but not every part, the
  change runs as one combined pass.
- At least half of the passes returned: the result stands, and the parts not reviewed are named.
- Fewer than half: one judge reviews the change instead, **once**, with no retry and no spare
  judge, if the caps allow a run; otherwise the review is unavailable.
- A team floor on the panel or the mode wins over the orchestrator, and the refusal is recorded.

What blocks is unchanged: findings merge through the same accounting, quote check and touched-lines
rule as one judge's. The same point raised by two passes is one item.

### Turning it on

| Layer | Setting |
| --- | --- |
| This run | `rigour review --reviewer --orchestrator` / `--no-orchestrator` |
| Environment | `RIGOUR_REVIEWER_ORCHESTRATOR=on` or `off` |
| Yours | `orchestrator` in your settings, or Studio's Setup page |
| The team's | `review.reviewer.orchestrator: off \| on \| required` in `rigour.yml` |

`required` stops a nearer layer turning it off, and gives **no verdict unless every part
returns**: never a partial review, and never one judge instead.

The verdict's `mode.specialists` records the parts picked, the passes and their slices, whether
each pass read beyond its slice (the signal for whether slicing works), the limit, the plan's
reason and any fallback.

## How it learns

Each judge starts from what your team already knows, written to a file it reads:

- the review lessons your team verified (`gates.deep.review_lessons: all` adds candidates, except those only review bots raised; `off` none), and the repository's rules, for what the change touches: up to thirty file lessons, at most three per touched file, so one file's many lessons never crowd out another file's only one, and never a lesson learned only from the pull request under review, which the judge already reads as the reviewer's own points. A lesson is context: it never blocks on its own;
- findings the team settled: dismissed as not a bug, or refuted with evidence in an earlier round
  on a file that has not changed since. Judges are told not to raise them again without something new;
- the docs that name the changed code.

**Every changed unit, accounted for.** The judge gets the change's units: each changed function where the
language parses (JavaScript, TypeScript), else each changed hunk named by the code around it (any language), at most
25, riskiest and largest first. For every one it must say either which finding is about it, or what it checked and
why it holds. A review with no findings is therefore "looked at each of these, and here is why each holds", never an
empty answer. A unit the answer leaves out gets one follow-up run, inside the caps; one still left out is shown as
**not reviewed**, never as passed: "Accounted for 7 of 8 changed units; not reviewed: conn.go :: Close." The count is
in the review record, and in `--json` as `coverage`. `review.coverage: false` turns it off.

**Where the lessons come from: evidence, not who wrote it.** `rigour learn-reviews` reads the
repository's merged pull requests. Every review point is a **candidate**, whoever wrote it: a person, an
AI posting under a person's login, or a review bot. It keeps the point's own words: its bold title, else
its first sentence and, when that only says what is wrong, the first sentence that says what to do, with
identifiers as written. Read again by a later version, a point never adds a second lesson: an undecided
one takes the text that version reads; one a person decided (promoted, rejected, dismissed, or with a
compiled check) keeps the wording they decided on, and the new one waits beside it in Studio and in
`rigour learn-reviews --list` until they take it with **Use this wording** or `--use-wording <id>` (the old
wording is kept as evidence). Who wrote it, and whether the pull request changed
those lines before merging, are recorded on the candidate and decide nothing: people paste AI text,
and agents apply review comments on their own. A candidate becomes a **lesson** only on evidence:

- **a person's correction**: they changed what an agent wrote. The after-edit hook keeps each file as
  the agent left it (in `.rigour/agent-writes/`, ignored by git); at the stop and the push, a file that
  now reads differently, other than by whitespace or a git checkout or pull, becomes a lesson with the
  change as its words. The rule writer then states the rule behind it, or finds none in a cosmetic edit;
- **a person's decision**: `--promote <id>` (with `--why`), recorded with their git email;
- **recurrence**, weak alone: the same point on two or more pull requests by different authors, raised
  independently: by different reviewers, or by one person in different words (a senior re-raising a
  standard counts; a bot rewording its own point on every pull request does not). At least one of the
  points must be a person's: review bots agreeing with each other never make a lesson. A point that is only
  a file path, or a bot's line-range scaffolding with nothing after it, is never a candidate.

A candidate only review bots raised is never served, not even with `gates.deep.review_lessons: all`; it
reaches agents once a person promotes it, or a person's point joins it and recurrence promotes it. Lessons an
earlier version promoted on bots' points alone are back to candidates, each with a `reclassified` record
saying "only review bots raised it (no person)", in Studio and in `rigour learn-reviews --list`. Other
candidates only review bots raised are hidden from both by default and counted ("N candidates from review
bots, hidden"); `--include-bots` or **Show bot points** lists them. Who raised a point comes only from the review
points: a later fix on its lines never makes a bot's candidate a person's. `--list --json` keeps every lesson.

**What happens after the merge never promotes on its own.** A later commit on the main branch that changes the lines a point named and says it fixed something, or a revert of the pull request, is recorded on the candidate (`rigour learn-reviews` records it as `lines`). Lessons an earlier version promoted on that alone are back to candidates, each with a `reclassified` record, listed first in Studio. The [outcome loop](OUTCOMES.md) goes further: It follows a point's lines
through every later commit as the code moves (within three lines either side, inside the window); a
commit that changes them, says it fixes something and touches at most fifteen files is recorded as
`lines` evidence, with CI regressing on the merge commit or a revert as context, and a fix elsewhere in
the file as `followup`. Studio shows that evidence on the candidate, with the fix commit, for a person
to promote or dismiss; the decision is theirs and final. It is evidence and not a verdict because, read
by a person against real history, a fix on the same lines was most often unrelated work: the same code
changing for another reason.

**Counter-evidence** holds a candidate back: its lines shipped unchanged and nothing needed fixing
within the window (30 days). With the outcome loop on, evidence can also **take a lesson back**: when
a review of a later pull request found it repeating the lesson, and that pull request merged anyway and
settled clean (CI passed, no fix on the lesson's file within the window, no revert), that is `against`
evidence. `learning.outcomes.demote_after` such pull requests (default 2), from more than one author or
merged at least a week apart, make a lesson that recurrence promoted a candidate again (`demoted`). A pull request
that followed the lesson, or that no review checked against it, never counts, and a lesson a person
promoted or corrected into being is never taken back; a person promoting it again is final. `--reject <id>` makes an **anti-lesson**: judges are told this team decided
against it, and it is never served as a lesson. Every piece of evidence stays on the lesson
(`--list` shows what promoted each). With `--until <time>`, only history before it counts, so a
measurement never sees the future. The pull request's author commenting on their own pull request is not
a review point. GitHub is read as the account in `review.github_account` (or an explicit
`GITHUB_TOKEN`), never silently as another signed-in account.

**Without GitHub.** The reviewer looks up the change's pull request with the GitHub CLI. When it cannot (no
`gh`, not signed in, or a GitLab or Bitbucket repository), it reports no verdict and says why: it never falls back
on its own. `rigour review --reviewer --blind` (or `RIGOUR_REVIEWER_BLIND=1`) reviews the change alone instead,
with no pull request lookup, description or human reviews. The output and the review record say "reviewed without
pull request context", and `--json` carries `blind: true`.

A point that names a path is about that file. One that names none is a **team standard**: shown
with a change, once it is a lesson, when it shares at least two meaningful words with the change (its
paths and the names on its added lines): up to three in the agent's question at the stop, up to
fifteen for a judge reading the whole pull request.

**A person decides how far a lesson reaches.** `rigour learn-reviews --scope <id> --to repo` makes it a
standard for the whole repository: it reaches every change, whatever its files or words, in the
briefing, the briefing on a file's first edit and the judge's context. Up to ten such standards are
served, the most-raised first. `--to folder` reaches every change in the lesson's folder; `--to file`
takes it back to its own file. Studio's lesson card does the same (**Make team standard**, **Folder only**,
**This file only**) and shows how far each lesson reaches. Each is recorded with your git email and `--why`
(refused in Studio without one); a scope says how far a
lesson reaches, never whether it is right, so only a lesson (not a candidate) is served. `--list` shows
each scope.

**A long-running pull request teaches as it goes.** `rigour learn-reviews --pr <n>` learns from that
one pull request's reviews, open or merged, with the same rules. `--until <time>` takes the pull
request as it stood then.

**Turning reviews into rules (`--rules`).** A senior's point is usually about one change ("the total is
computed before the discount is applied"). With `rigour learn-reviews --rules`, the team's reviewer CLI
writes the rule behind each point that evidence made a lesson ("apply discounts before computing a total"), or judges
it no rule (a test report, a status note, a one-off fix). This is memory, never training: the rule
is text the next judge and agent read, nothing is fine-tuned, and no model is produced. Three
guards keep it honest:
- **A lesson never blocks on its own.** It is context; a finding still needs its input, consequence
  and quote.
- **The person's words travel with the rule.** Every lesson a judge or agent sees shows the original
  words and the pull request beside the rule, and every judgement, "no rule" included, is logged
  in `.rigour/review-rules-log.jsonl`.
- **Only lessons get rules**: the model is paid only for what evidence promoted, once each. A lesson
  it finds no rule in is kept, marked, and never promoted again.

Each call runs isolated and read-only like a judge, is sent only the points, and counts toward
`review.reviewer.max_usd_per_day`. A lesson already written is never sent again.

**Dismissing a finding is the team's decision, and it is off by default.** A wrong finding is fixed
by improving the reviewer (its rules, its prompt, the reviewers it runs); a right one by fixing the
code. A team that wants an escape hatch turns on `review.reviewer.dismissals: true`; no personal
setting can. Then `rigour dismiss <id> --reason "…"`, or **Not a bug** in Studio, records the
finding with its reason and who dismissed it (their git email). It never blocks again, and neither
does the same finding re-worded: the same file and class, within a few lines, in mostly the same
words. A different bug nearby is never covered by it. Every later judge is told, the background
review included. Commit `.rigour/dismissed-review-items.json` so the record is reviewed and shared.
When a team turns dismissals off again, the recorded ones stop counting.


### Lessons compiled into checks

A verified lesson can become a check that runs without a model, on every review, for free. Only a lesson
a person confirmed (promoted or corrected) or that recurred across pull requests qualifies; one an
outcome alone suggested never does. Compilation is a template, not a model: the lesson must name its
file and its symbols in backticks and say what is wrong in so many words:

| The lesson says | The check reports |
| --- | --- |
| never, avoid, do not use `` `a` ``; use `` `b` `` instead of `` `a` `` | `a` on a changed line of the lesson's file |
| always, must, every … `` `a` `` … `` `b` `` | `a` on a changed line with no `b` within three lines |

`rigour learn-reviews --compile` (or **Propose checks** on Studio's learning page) proposes a check for
every lesson a template fits and lists them all, each with how it fired on the main branch's last 100
changes to its files: on merged pull requests a review found the lesson repeating in, and on the
others (a false fire, or a catch the review missed). These are counts, with a percentage only from
ten. A proposed check runs only once a person approves it (`--approve-check <id>`, or **Approve** in
Studio), and `--withdraw-check <id>` (**Take back**) takes it back.

Where an approved check ran on a change (the change touched its files), its lesson leaves the judge's
and the deep PR review's prompt, and the prompt says instead that the lesson is covered by that check,
with the check's findings on the change listed as already found. Where it did not run (`rigour check
--deep`, a change elsewhere), the lesson stays. Every decision is kept, on the check and as evidence
on its lesson. An approved check whose lesson a person later rejects, or evidence takes back, is
suspended: it stops running, Studio shows why, and the lesson goes back to the model reviewer.
Agents' briefings keep the lesson either way. Checks live in `.rigour/compiled-checks.json`: commit it, so the team reviews
them like code. Who approved or took back each check, by git email, is committed with it; without a
git email set in the checkout, the decision is refused. Each finding names its lesson. A compiled check is a note unless
`gates.compiled_lessons.block` is on.

## Where you see it

- `rigour review --reviewer`: the verdict, what ran and why, and each finding with its id. What is
  shown gets the same discipline as what blocks: blocking items in full; then up to five should-fixes
  the judge could show (a verified quote), worth a person's time and never blocking; everything else
  (working notes, disputed items, items whose quote or file the checkout does not have, dismissed
  items) folded into one count. `--notes` lists them all. The same point found in several places is
  one item carrying every location, and it blocks until every location is fixed. A rule break and the
  finding it caused on the same lines are one item too.
- **The record of the review**, written beside the verdict (`<git common dir>/rigour-reviewer/*.record.json`)
  and carried in `rigour review --json` under `reviewer.record`: what Rigour verified against the
  checkout (blocking items, should-fixes, the repository rules served and answered, the lessons served
  and found to apply, prior points open and resolved, how much was unverified or a note), what it only
  recorded as reported (human reviews seen), what people decided (dismissals), who judged (reviewer,
  version, model, cost, turns), and an integrity hash over all of it, so a copy can be checked against
  the original. `rigour review-post` puts the record in the pull request's summary comment: blocks in
  full, up to five should-fixes, the counts and the hash.
- Telemetry, only if you opted in: one anonymous `reviewer_completed` event with counts and a cost
  bucket, never code or finding text ([Telemetry](../TELEMETRY.md)).
- `rigour review --status`: what the background reviewer last decided on this branch, or why its
  last review was skipped or could not run.
- Studio's **Review** page: the verdict first, then the risky functions your agent checked.
- MCP `rigour_reviewer_verdict`: the confirmed findings, for the agent doing the fixing. It never
  runs a model and never dismisses: that is a person's call.
- In a fix round, `rigour review --scope` shows what changed beyond the points the review raised.

## Where it does not run

The [pull request check](./CI.md) reviews with a model key in CI and does not run the reviewer: the agent
CLIs the judges use are on your machine, not on the CI runner. Run the panel before pushing
(`on_push: wait`, or `rigour review --reviewer --full` before asking for a human review).

## Upgrading

Nothing changes until you turn something on: the default is still one judge, no panel. The first
review after upgrading is a full review of the branch rather than a delta, because the reviewer's
instructions changed; later pushes get deltas again.

## Measure it before you rely on it

The quickest proof: `rigour backtest --last 20 --reviewer` runs the review on the last twenty merged
pull requests and leads with blocks on approved heads and points caught rounds early
([BACKTEST.md](BACKTEST.md)).

What is designed here (the matching, the majority rule, the consequence rule) is tested; how much a
panel improves on one judge is not yet measured on public pull requests, and depends on your code
and your reviewers. The backtest measures it on yours.

`rigour backtest --reviewer` replays reviewed pull requests with their reviews hidden. With two or
more judges it also reports each judge's catches, what only that judge caught, how often each pair
of judges agrees (Cohen's kappa: when it is high, they share blind spots and another judge adds
little) and the cost per caught point. That is how you choose one, two or three judges, and
whether `escalate: risk` loses anything. See [Backtest](./BACKTEST.md).
