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
- Each source comment is labelled once, before any change it measures, and never again:
  - **a**: it asks for something a person could act on (a change, a fix, a rule, a question to answer in code);
  - **b**: it does not (praise, status, thanks, a summary of what the pull request does).
- A run's precision is the share of its candidates, among those whose every source is labelled, that come from an
  **a** source, with a Wilson 95% interval.
- **Looks broken** is mechanical, per run: a candidate that starts with Or / And / But, or ends on a connector
  (", or", "and"). A lowercase start alone is not counted: reviewers often write sentences that way. `REPORT.md`
  lists them for spot checks.

## Report

`node scripts/learning-report/report.mjs` writes `REPORT.md` from every run in `results/` and the labels.
