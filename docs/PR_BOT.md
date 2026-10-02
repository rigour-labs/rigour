# PR Bot

The PR bot is the safety net behind the review your agent does before the PR. It reviews what is left, posts a few precise comments, and stays quiet otherwise.

## Set up

1. Copy [`examples/github/rigour-review.yml`](../examples/github/rigour-review.yml) to `.github/workflows/rigour-review.yml`.
2. Optional: add your model key as a repository secret named `RIGOUR_API_KEY`. Without it, only the deterministic gates run and no code leaves the runner.
3. Optional: run `rigour review-export` and commit `.rigour/reviewed.json`, so the bot skips functions your agents already reviewed.

The checkout must fetch history (`fetch-depth: 0`): the bot reviews the branch against its base.

**Pinned install (recommended):** add Rigour as a devDependency (`pnpm add -D @rigour-labs/cli`) and install dependencies before the action. The action then runs that exact version from your lockfile, so it goes through your normal dependency review. Without it, the action fetches `@rigour-labs/cli@<version>` with `npx`.

## Inputs

| Input | Default | Meaning |
| --- | --- | --- |
| `api-key` | — | Model key. Passed to Rigour as `RIGOUR_API_KEY`, never on a command line. |
| `provider` | `claude` | `claude`, `openai`, `openrouter`, `gemini`, `groq`, `mistral`, `together`, `deepseek`, `ollama`, or any OpenAI-compatible name with `base-url`. |
| `model` | provider default | e.g. `claude-sonnet-5-5`, or `anthropic/claude-sonnet-5.5` on OpenRouter. |
| `base-url` | — | API base URL for OpenAI-compatible providers. |
| `max-comments` | `2` | Inline comments at most per push. |
| `enforce` | `false` | `true` makes this a check a branch can require: the job fails when the review is FAIL or ERROR, after posting, and the review trusts nothing the PR wrote (see below). |
| `version` | `latest` | `@rigour-labs/cli` version. |

## Make it a required check

By default the job posts its review and passes, whatever it found. With `enforce: true`:

- **FAIL** (findings on changed lines) and **ERROR** (a check that could not run) fail the job, after the review is posted so the PR shows why. Mark the job as required in branch protection and only a PASS merges.
- The review **trusts nothing the PR wrote**:
  - The model reviews every risky changed function. Normally functions that agents recorded as reviewed (`.rigour/review-ledger.jsonl`, a committed `.rigour/reviewed.json`) are skipped to save cost; an enforcing check does not take an agent's word for it. The deterministic checks always run either way.
  - Dismissals (`.rigour/dismissed.json`), check outcomes and `rigour.yml` are read from the base branch, so a PR cannot dismiss its own finding or switch a check off. A dismissal made in the PR takes effect once it merges.
  - The CLI is the `version` you name, fetched with npx, never the PR's own `node_modules`.
- The summary says how many findings were dismissed and names any `rigour.yml` or `.rigour/` file the PR edits.

On `pull_request`, GitHub runs the workflow file from the PR itself, so a PR can still edit the workflow. To make the check tamper-proof, require it through a [repository ruleset](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets) ("Require workflows to pass before merging"), which runs the workflow from the default branch, or protect `.github/` with CODEOWNERS.

```yaml
- uses: rigour-labs/rigour@main
  with:
    api-key: ${{ secrets.RIGOUR_API_KEY }}
    enforce: true
```

## What it posts

- **Inline comments:** at most `max-comments`, the most severe first (security and proven findings before heuristics). A finding is posted once; a later push does not repeat it. A finding about a changed function but rooted on an unchanged line is posted on the nearest changed line and says where the root cause is.
- **One summary comment**, edited in place on every push: the verdict, how many findings, how many changed functions the model reviewed by risk, how many were already reviewed before the PR, the model, and what the run cost.
- **The job summary** gets the same summary.

## What the model sees

With a key, Rigour reviews the pull request as one conversation: the diff with line numbers (lockfiles and build output left out), the riskiest changed functions with what to check in each, and the PR description. The model can read files and search the repository (read-only, never `.env` files, keys or credentials) before reporting. A finding is kept only if it names a line and identifiers the model actually read. If nothing in the PR is risky, no model call is made.

## Permissions

`contents: read` and `pull-requests: write`. The bot uses the workflow's `GITHUB_TOKEN`.
