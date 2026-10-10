# Learning-quality report

What Rigour's learning makes of real review history, measured on public repositories, before and after each
change to the learning pipeline. It costs nothing: GitHub reads and git fetches, no model.

## Input

- `prs.json`: per repository (immich-app/immich 50, tailscale/tailscale 40, logto-io/logto 40), the most recent
  pull requests (by creation) merged before the cutoff with at least one review comment or non-empty review body
  from a person (not a bot) other than the author. The rule and counts were fixed before any result was read; pinned
  once (`select.mjs`), so every run reads the same input. zulip/zulip was dropped: its clone passed the 1 GB cap with
  both clone modes, and logto had the most human review per merged pull request of the two replacements.

## A run

`npm run learning-report -- <label> <scratch dir>` (`scripts/learning-report/run.mjs`) after `npm run build` (each run works in its own folder
under the scratch dir, `<label>-<process id>`, removed at the end, so two runs never clear each other's clones):

- clones each repository blobless (`--filter=blob:none --no-checkout`: commits and trees; file contents fetched when
  read), stops it if it passes 1 GB, and deletes it as soon as the repository is done;
- runs `learnFromReviews` once per pinned pull request into a fresh lessons store, with no main branch (no outcome
  evidence) and no rule writer (no model);
- writes `results/<label>.json`: inline comments, review bodies, raw points (people / bots), candidates after
  merging, verified lessons by reason, the clone's size and the run's time, and every candidate with the source
  comments its points came from.

## Precision

- `sample.mjs` draws 40 candidates per repository from the baseline run with a fixed seed, and writes each
  candidate's source comments (the inline comment, or the review whose body the point is in) to
  `labels/<repo>.json`, with the comment's own text.
- Each source comment is labelled once, before any change it measures. The rubric judges the text, not its author
  (whether a bot wrote it is counted separately):
  - **a**: it asks for something a person could act on (a change, a fix, a rule, a question to answer in code), or
    names a concrete defect;
  - **b**: it does not (praise, status, thanks, a summary of what the pull request does).
- Who labelled: the AI session that builds the learning changes, in one pass, before any of them. The reviewer
  spot-checked 30 (10 per repository) and disagreed on 2, both logto review bodies labelled b that name concrete
  defects. All 10 logto b labels were then re-checked against the rubric; 8 became a, each with its reason in
  `recheck`, in a commit of their own. No label changes after that.
- **Review bodies are labelled by unit.** One review body (a review bot's summary, say) can hold both requests and
  lines that only describe the pull request. So every review-body source in the sample is split into units
  (`unitsOf`: each non-empty line once HTML is removed, a prose line split into its sentences, a fenced code block as
  one unit), and each unit is labelled once, by the same rubric, before any learning change. A candidate from a
  review body is credited by the units its text came from (`unitsFor`), and counts as **a** only if every one of
  them is **a**: a candidate that mixes an a unit with a b unit is a split defect and counts as **b**. Inline
  comments are one point each and keep their source label.
- The unit rubric, with invented examples:
  - **a**, a bullet naming a defect: `* This retry loop has no upper bound; cap it and log the last error.`
  - **a**, a sentence naming a defect: `Missing lock in refreshCache: it reads the map without holding mu.`
  - **a**, a suggested change: a fenced `suggestion` block, or a status line that itself names the defect
    (`Stale entries can be served after a config reload.`).
  - **b**, an overview line: `Adds caching for the settings page.`, `Pull request overview`, a "Changes:" bullet
    that describes what the pull request does.
  - **b**, a status or approval line: `Changes recommended`, `Approval recommended`, `Looks good, thanks!`.
  - **b**, scaffolding: a heading, a file-summary table row, a location line (`**src/cache.ts:42**`), a
    "This issue also appears in" list, review metadata (`Files reviewed: 2/2`), a code block that only quotes
    existing code.
- Reviewer spot-check of unit labels: 15, 0 disagreements, 1 borderline (a unit giving the reason next to a
  defect, labelled a; defensible either way, unchanged).
- The comment text the labeller read stays outside the repository (`TEXT_CACHE`, default
  `~/Workspace/Projects/Personal/rigour-labs/notes/learning-report/`); the label files hold the URL, so anyone can
  read the comment where it was written.
- A run's precision is the share of its candidates, among those whose every source is labelled, that come from an
  **a** source, with a Wilson 95% interval.
- **Looks broken** is mechanical, per run: a candidate that starts with Or / And / But, or ends on a connector
  (", or", "and"). A lowercase start alone is not counted: reviewers often write sentences that way. `REPORT.md`
  lists them for spot checks.

## Recurrence over the learner's default window

`recurrence.mjs` reads the 100 most recent merged pull requests per repository (the default of
`learn-reviews --limit`) from the GitHub API only, builds candidates with Rigour's own functions (with no checkout, a
comment's identifiers come from its own text), and counts recurrence under the current rule (`mergeLessons`) and under
a looser one (the same person and a shared identifier on different pull requests, any file). It measures; it changes
no rule. Results: `results/recurrence-100.json`, counts and URLs only.

## Report

`node scripts/learning-report/report.mjs` writes `REPORT.md` from every run in `results/` and the labels.

`npm run learning-report:brief-check -- <label>` (`scripts/learning-report/brief-check.mjs`), after a run, checks what the
brief serves from that run's lessons: the real `rigour brief --files <file> --json` on each repository's 5 files with
the most candidates a person raised, serving candidates (`review_lessons: all`). It counts items served per file (at
most 3), uncited and broken into `results/<label>.brief.json`; the briefs themselves quote review comments, so they
stay in the local cache (`briefs/<label>.json`, and `brief-check/<repo>.txt`, every served item one per line).
