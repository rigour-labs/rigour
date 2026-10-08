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
    Copilot instructions), the fifteen most relevant to the change, answered one by one: followed, broken,
    or not applicable, with the code that breaks one quoted. A rule the team worded as a requirement
    (must, never, always, only, every, do not), broken with its quote verified, blocks; guidance broken is a
    should-fix. The rule's words and weight come from the file, never from the judge.
11. **The diff as a person reads it.**

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
- **A human's open point blocks only where the judge quotes the code that keeps it open**, checked like a
  finding: a later commit may already have done what it asked. And a point a human already raised and
  accepted as non-blocking is never escalated into a blocking finding.

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

Rigour runs the loop itself: the model asks for a read-only tool (`read_file`, `search`, `list_dir`,
a read-only `git`), Rigour runs it inside the checkout and the review's own input folder, and hands
the result back until the model answers. The same prompt, the same evidence contract, the same
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
| `enabled`, `mode`, `panel` (on or off), `judges`, `escalate`, `reviewers`, `models`, `max_runs_per_day`, `max_usd_per_day` | The team in `rigour.yml`, and each person for their own runs |
| `panel: required`, `mode_required`, `dismissals`, `on_push`, `timeout_ms`, `panel_max_items`, `cross_models`, `model`, `judge_env` | The team only |

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
cost.

## How it learns

Each judge starts from what your team already knows, written to a file it reads:

- the review lessons your team verified (`gates.deep.review_lessons: all` adds candidates, `off` none), and the repository's rules, for what the change touches. A lesson is context: it never blocks on its own;
- findings the team settled: dismissed as not a bug, or refuted with evidence in an earlier round
  on a file that has not changed since. Judges are told not to raise them again without something new;
- the docs that name the changed code.

**Where the lessons come from: evidence, not who wrote it.** `rigour learn-reviews` reads the
repository's merged pull requests. Every review point is a **candidate**, whoever wrote it: a person, an
AI posting under a person's login, or a review bot. Who wrote it, and whether the pull request changed
those lines before merging, are recorded on the candidate and decide nothing: people paste AI text,
and agents apply review comments on their own. A candidate becomes a **lesson** only on evidence:

- **outcome**: after the merge, a commit on the main branch changed the lines the point named and says
  it fixed something, or the pull request was reverted;
- **a person's correction**: they changed what an agent wrote. The after-edit hook keeps each file as
  the agent left it (in `.rigour/agent-writes/`, ignored by git); at the stop and the push, a file that
  now reads differently, other than by whitespace or a git checkout or pull, becomes a lesson with the
  change as its words. The rule writer then states the rule behind it, or finds none in a cosmetic edit;
- **a person's decision**: `--promote <id>` (with `--why`), recorded with their git email;
- **recurrence**, weak alone: the same point on two or more pull requests by different authors, raised
  independently: by different reviewers, or by one person in different words (a senior re-raising a
  standard counts; a bot rewording its own point on every pull request does not). A point that is only
  a file path, or a bot's line-range scaffolding with nothing after it, is never a candidate.

**Counter-evidence** holds a candidate back: its lines shipped unchanged and nothing needed fixing
within the window (30 days). `--reject <id>` makes an **anti-lesson**: judges are told this team decided
against it, and it is never served as a lesson. Every piece of evidence stays on the lesson
(`--list` shows what promoted each). With `--until <time>`, only history before it counts, so a
measurement never sees the future. The pull request's author commenting on their own pull request is not
a review point. GitHub is read as the account in `review.github_account` (or an explicit
`GITHUB_TOKEN`), never silently as another signed-in account.

A point that names a path is about that file. One that names none is a **team standard**: shown
with a change, once it is a lesson, when it shares at least two meaningful words with the change (its
paths and the names on its added lines): up to three in the agent's question at the stop, up to
fifteen for a judge reading the whole pull request.

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

## Where you see it

- `rigour review --reviewer`: the verdict, what ran and why, and each finding with its id. What is
  shown gets the same discipline as what blocks: blocking items in full; then up to five should-fixes
  the judge could show (a verified quote), worth a person's time and never blocking; everything else
  (working notes, disputed items, items whose quote or file the checkout does not have, dismissed
  items) folded into one count. `--notes` lists them all. The same point found in several places is
  one item carrying every location, and it blocks until every location is fixed.
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

What is designed here (the matching, the majority rule, the consequence rule) is tested; how much a
panel improves on one judge is not yet measured on public pull requests, and depends on your code
and your reviewers. The backtest measures it on yours.

`rigour backtest --reviewer` replays reviewed pull requests with their reviews hidden. With two or
more judges it also reports each judge's catches, what only that judge caught, how often each pair
of judges agrees (Cohen's kappa: when it is high, they share blind spots and another judge adds
little) and the cost per caught point. That is how you choose one, two or three judges, and
whether `escalate: risk` loses anything. See [Backtest](./BACKTEST.md).
