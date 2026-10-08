# Pull requests and CI

Rigour can review every pull request in GitHub Actions and post what it finds on the pull request. This
page covers what that check does, a workflow to copy, how to make it a required check, and what to do
when it misbehaves. For what Rigour does on a developer's machine, see
[During development](./DEVELOPMENT.md).

## What the pull request check does

The check runs two commands:

1. `rigour review --base origin/<base branch> --json` reviews the branch against its base and writes a
   JSON report.
2. `rigour review-post --report <file>` posts that report on the pull request.

The review is the same one the push gate runs, with the same rule for what blocks
([What blocks](./DEVELOPMENT.md#what-blocks-and-what-does-not)):

- It reports findings on the lines the pull request changed. Problems the base branch already had are
  counted, not listed.
- Findings in `.rigour/dismissed.json` are left out and counted as dismissed.
- With a model key in the `RIGOUR_API_KEY` secret, a model also reviews the riskiest changed functions
  ([Model review](./MODEL_REVIEW.md)). Without a key, only the deterministic checks run and no code
  leaves the runner.

The verdict is one of three:

| Verdict | Meaning |
| --- | --- |
| `PASS` | Nothing on the changed lines must be fixed. |
| `FAIL` | At least one finding on the changed lines must be fixed. |
| `ERROR` | The review did not finish: a model review was asked for and did not run, or a check that can block crashed. An `ERROR` is never a pass. |

`rigour review-post` then posts (and, when the report includes the reviewer's record, the summary carries it: blocking items, up to five should-fixes, the counts and the integrity hash):

- **Inline comments**, at most two by default (`--max-comments`). The most severe go first, and among
  equal severity, security findings before model findings before the rest. A finding is posted once:
  a later push does not repeat it.
- **One summary comment**, edited in place on every push: the verdict, the number of findings, notes
  elsewhere in changed files, how many findings were dismissed, any change the pull request makes to
  `rigour.yml` or `.rigour/`, and, with a model, how many changed functions it reviewed, the model and
  what the run cost.
- **The job summary** gets the same summary text.

Each inline comment ends with the `rigour dismiss <key>` command for that finding.

## What it does not do

- **It does not run the reviewer.** The [reviewer](./REVIEWER.md), from one judge up to a panel, runs
  your coding agents' own CLIs (Claude Code, Codex, Cursor) with each developer's login. Those CLIs live
  on developers' machines, not on a CI runner, so the reviewer runs at push and on request
  (`rigour review --reviewer`). The model review in CI is separate: it calls a provider's API with a key.
- **It does not run your formatter, linter, type check or tests.** The push gate runs the team's
  `commands`; the CI review leaves them out. Keep your existing CI jobs for those.
- **It does not fail the job by default.** It posts and passes. See
  [Make it a required check](#make-it-a-required-check).

## The workflow

Copy this to `.github/workflows/rigour-review.yml`. Two things to set:

- **The version.** The `RIGOUR_VERSION` line pins the CLI. Set it to an exact version you have tested
  (`npm view @rigour-labs/cli version` prints the latest) and change it on purpose. Do not use `latest`:
  a new release would change your check without a pull request.
- **The model key (optional).** Add your provider's key as a repository secret named `RIGOUR_API_KEY`.
  Without it, the check runs the deterministic checks only.

```yaml
name: Rigour review
on:
  pull_request:

permissions:
  contents: read        # check out the code
  pull-requests: write  # post the inline comments and the summary comment

concurrency:
  group: rigour-review-${{ github.event.pull_request.number }}
  cancel-in-progress: true  # a new push stops the review of the old one

jobs:
  review:
    runs-on: ubuntu-latest
    env:
      RIGOUR_VERSION: 'X.Y.Z'     # PIN: the exact @rigour-labs/cli version you tested
      RIGOUR_PROVIDER: claude     # used only when RIGOUR_API_KEY is set
      RIGOUR_MODEL: ''            # empty: the provider's default model; name one to control cost
      RIGOUR_API_BASE_URL: ''     # only for a gateway or self-hosted endpoint; built-in providers need none
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0  # the review diffs this branch against its base

      - uses: actions/setup-node@v4
        with:
          node-version: 22

      # TypeScript projects: install dependencies so the typed checks can load tsconfig.json.
      # Without them those checks cannot run and the verdict is ERROR. Remove for other projects.
      - name: Install project dependencies
        run: npm ci

      - name: Install Rigour
        run: npm install -g "@rigour-labs/cli@${RIGOUR_VERSION}"

      - name: Review the change
        env:
          RIGOUR_API_KEY: ${{ secrets.RIGOUR_API_KEY }}
          BASE_REF: ${{ github.base_ref }}
        run: |
          args=(review --base "origin/${BASE_REF}" --json)
          if [ -n "$RIGOUR_API_KEY" ]; then
            args+=(--deep --provider "$RIGOUR_PROVIDER")
            [ -n "$RIGOUR_MODEL" ] && args+=(--model-name "$RIGOUR_MODEL")
            [ -n "$RIGOUR_API_BASE_URL" ] && args+=(--api-base-url "$RIGOUR_API_BASE_URL")
          fi
          code=0
          rigour "${args[@]}" > "$RUNNER_TEMP/rigour-review.json" || code=$?
          echo "rigour review exited $code"
          # Print the verdict and why a review did not finish. A report without a status is a run
          # that did not start (bad rigour.yml, a git error): print it and stop.
          node -e '
            const r = require(process.argv[1]);
            if (!r.status) { console.error(JSON.stringify(r)); process.exit(1); }
            console.log("Verdict: " + r.status);
            if (r.gate_errors?.length) console.log("Could not run: " + r.gate_errors.join(", ") + (r.typed_error ? " (" + r.typed_error + ")" : ""));
            if (r.deep?.error) console.log("Model review did not run: " + r.deep.error);
          ' "$RUNNER_TEMP/rigour-review.json"

      - name: Post the review
        env:
          GITHUB_TOKEN: ${{ github.token }}
        run: rigour review-post --report "$RUNNER_TEMP/rigour-review.json" --max-comments 2
```

Notes on the workflow:

- **Node 22.13 or later.** The CLI requires it.
- **`fetch-depth: 0`.** The review finds where the branch left its base with `git merge-base`, which
  needs the history and the `origin/<base>` branch.
- **The key never goes on a command line.** Rigour reads `RIGOUR_API_KEY` from the environment.
- **A provider named without a key is an error,** not a quiet switch to another model. That is why the
  workflow adds `--provider` only when the secret is set.
- **Install Rigour as a devDependency instead, if you prefer.** Then `npm ci` installs the version your
  lockfile pins, it goes through your normal dependency review, and you run `npx rigour` in the two
  steps instead of the global install. The enforcing check below should not do this
  ([why](#make-it-a-required-check)).

### Optional: skip what was already reviewed

When a developer's agent reviews a risky function before the pull request (`rigour review-task`, then
`rigour review-ack` or the MCP `rigour_review` tool), Rigour records it locally. To let CI see those
records, run `rigour review-export` and commit `.rigour/reviewed.json` (hashes and verdicts only, no
code). The model review then skips functions whose exact code was already reviewed. Any edit to a
function makes its record stale. An enforcing check ignores these records.

### The composite action

The repository root also contains a composite action (`action.yml`) that runs the same two commands.
If you use it, reference a release tag, which has the form `vX.Y.Z`
(`uses: rigour-labs/rigour@vX.Y.Z`), never `@main`, and set its `version` input to the same version:
the input defaults to `latest`. When not enforcing, the action runs `node_modules/.bin/rigour` if the
repository installs Rigour itself, and otherwise fetches the CLI with `npx`. It does not install your
project's dependencies; add that step before it for a TypeScript project. Its inputs are listed in
`action.yml`.

## Make it a required check

By default the job posts and passes, whatever it found. To block merging on a `FAIL` or `ERROR`,
change two steps and add one.

**1. Review independently.** Add `--independent` to the review:

```bash
args=(review --base "origin/${BASE_REF}" --json --independent)
```

With `--independent` the review trusts nothing the pull request wrote:

- The model reviews every risky changed function, whatever agents recorded as reviewed
  (`.rigour/reviewed.json` and the local log are ignored). The summary says how many recorded reviews
  were set aside.
- `.rigour/dismissed.json`, the check outcomes and `rigour.yml` are read as of the merge base, not as
  the pull request left them. A pull request cannot dismiss its own finding or switch a check off. A
  dismissal made in the pull request takes effect once it is merged.

**2. Use the pinned global install.** Keep `npm install -g "@rigour-labs/cli@${RIGOUR_VERSION}"` and
call `rigour`, not `npx rigour`: the pull request's own lockfile should not choose the binary that
judges it.

**3. Fail after posting.** Add this as the last step, so the pull request shows why it failed:

```yaml
      - name: Enforce the verdict
        run: |
          status=$(node -e "process.stdout.write(String(require(process.argv[1]).status || 'ERROR'))" "$RUNNER_TEMP/rigour-review.json")
          echo "Rigour review: $status"
          [ "$status" = "PASS" ]
```

`FAIL` and `ERROR` both fail the job. Only `PASS` lets it pass.

### Require it on the branch

In the repository's settings, add a branch ruleset for your default branch with **Require status checks
to pass** and select the job's check (`review` in the workflow above). A pull request can then merge
only when the check passes.

A `pull_request` workflow runs the workflow file from the pull request, so a pull request can still
edit the workflow that judges it. To close that gap, either:

- protect `.github/workflows/` with a `CODEOWNERS` entry and require review from code owners, or
- on an organization or enterprise, use a ruleset with **Require workflows to pass before merging**,
  which runs a workflow stored in a repository you choose.

The summary comment also names any `rigour.yml` or `.rigour/` file the pull request edits, so a
reviewer sees a change to Rigour's own settings.

## What runs where

| What | Where | Notes |
| --- | --- | --- |
| Fast checks after every edit | Developer's machine | Agent hooks ([During development](./DEVELOPMENT.md#the-three-moments)). |
| Branch review before the agent says "done" | Developer's machine | Agent stop hook, at most three stops. |
| Branch review, format, lint, type check and related tests before `git push` | Developer's machine | git's `pre-push` hook, set up by `rigour setup`. |
| The reviewer (one judge or a panel) | Developer's machine | Uses the agents' own CLIs and logins ([The reviewer](./REVIEWER.md)). |
| Risky-function review by the agent (`rigour review-task`, `rigour review-ack`) | Developer's machine | Shared with CI only through a committed `.rigour/reviewed.json`. |
| Dismissing a finding (`rigour dismiss`) | Developer's machine | Shared through a committed `.rigour/dismissed.json`, which CI reads. |
| Learning from past reviews (`rigour learn-reviews`) | Developer's machine | Reads GitHub with `GITHUB_TOKEN`, the account named in `review.github_account`, or the `gh` login; writes local files only. |
| Branch review of the pull request (`rigour review --base`) | CI | Deterministic checks always. |
| Model review with an API key (`--deep` with `RIGOUR_API_KEY`) | CI, or a machine with a key | Riskiest changed functions only. |
| Posting comments (`rigour review-post`) | CI only | Needs the GitHub Actions environment. |

## Cost control

Only the model review costs money. The deterministic checks run on the runner.

- **No key, no cost.** Without `RIGOUR_API_KEY`, no model is called.
- **Only risky functions go to the model.** Rigour scores each changed function for risk. Functions
  below `gates.deep.router.min_score` (default 1) get the deterministic checks only, and at most
  `gates.deep.router.max_functions` (default 12) go to the model. When no changed function is risky, no
  model call is made.
- **Name the model.** `RIGOUR_MODEL` sets `--model-name`. Leaving it empty uses the provider's default
  model, which may not be the one you would pay for.
- **Skip what was reviewed.** A committed `.rigour/reviewed.json` lets the non-enforcing check skip
  functions already reviewed before the pull request. An enforcing check reviews them anyway.
- **Bound the run.** `gates.deep.budget_ms` caps the whole model review; files not started in time are
  reported as skipped. `gates.deep.max_tokens` and `gates.deep.timeout_ms` bound each call.
- **One review per pull request at a time.** The `concurrency` block cancels the review of an older push
  when a new one arrives.
- **See what each run cost.** The summary comment shows the model and the cost when it is known
  (reported by the provider, or tokens times list price; nothing for a model without a known price).

These settings are described in [Configuration](./CONFIGURATION.md).

## Pull requests from forks and Dependabot

GitHub limits what a `pull_request` workflow gets when the pull request comes from a fork:

- **Secrets are not passed**, except `GITHUB_TOKEN`. `RIGOUR_API_KEY` is empty, so the check runs the
  deterministic checks only.
- **`GITHUB_TOKEN` is read-only.** `rigour review-post` cannot post: it prints
  `Posted 0 inline comment(s); summary not updated.` and exits 0. The job summary is still written.
- **Dependabot pull requests are treated the same way.**

With the enforcing variant, the verdict still fails the job, and the job summary shows why.

Do not switch to `pull_request_target` to get secrets for forks. It runs with the base repository's
secrets and a write token, and checking out the pull request's code under it runs untrusted code with
both. GitHub's documentation warns against it.

## Exit codes

`rigour review`:

| Code | Meaning |
| --- | --- |
| 0 | `PASS` |
| 1 | `FAIL` |
| 2 | The command was called wrongly or the input is bad: invalid `rigour.yml`, a missing file, a git error, a provider named without a key. With `--json`, stdout has `{"error": ...}` instead of a report. |
| 3 | `ERROR`, or an internal error. |

The workflow above does not stop on 1 or 3: the report is still posted. It stops when the report has
no verdict (code 2 or an internal error), and prints why.

`rigour review-post` exits 0 when it ran, even if GitHub refused a comment. It exits non-zero, saying why,
when the report has no verdict (the review did not start), when it is not in GitHub Actions on a
`pull_request` event, or when it cannot read the report or list the pull request's comments.

## Troubleshooting

**`git merge-base origin/main HEAD failed`.** The checkout is shallow, or the base branch was not fetched. Set `fetch-depth: 0` on
`actions/checkout`.

**The verdict is `ERROR`.** The summary comment gives the verdict, not the reason. The "Review the
change" step's log prints it, from the report's `gate_errors`, `typed_error` and `deep.error` fields:

- *Could not run: typed-checks-unavailable.* The project has a `tsconfig.json` Rigour could not load,
  usually because dependencies are not installed. Install them before the review step, and run the
  framework's sync step if it has one.
- *Model review did not run.* A wrong key, provider, model name or base URL, or the provider failed.
  The message is the provider's error.

**The summary has no "Model:" line.** No model ran. The secret is not set, is named differently, or is
not available to this pull request (a fork or Dependabot).

**`--provider claude needs an API key`.** The workflow passed `--provider` without a key. Add
`--provider` only when `RIGOUR_API_KEY` is set, as the workflow above does.

**`summary not updated` and no inline comments.** The token cannot write to the pull request: the
`permissions` block is missing `pull-requests: write`, or the pull request is from a fork.

**A finding is in the summary but has no inline comment.** Only the first `--max-comments` findings are
posted inline. GitHub also refuses a comment on a line outside the pull request's diff; that comment is
dropped and the summary still goes out.

**Comments posted by another identity are not recognised.** Rigour treats only comments from
`github-actions[bot]` as its own. If you post with a GitHub App or another token, set
`RIGOUR_BOT_LOGIN` to that account's login in the post step, or every push adds a new summary comment.

**A dismissal in the pull request has no effect.** With `--independent`, dismissals are read from the
base branch. The dismissal applies once it is merged.
