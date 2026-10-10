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

`node scripts/learning-report/run.mjs <label> <scratch dir>` after `npm run build`:

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
