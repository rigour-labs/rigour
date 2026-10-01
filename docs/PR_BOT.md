# PR Bot

The PR bot is the safety net behind the review your agent does before the PR. It reviews what is left, posts a few precise comments, and stays quiet otherwise.

## Set up

1. Copy [`examples/github/rigour-review.yml`](../examples/github/rigour-review.yml) to `.github/workflows/rigour-review.yml`.
2. Optional: add your model key as a repository secret named `RIGOUR_API_KEY`. Without it, only the deterministic gates run and no code leaves the runner.
3. Optional: run `rigour review-export` and commit `.rigour/reviewed.json`, so the bot skips functions your agents already reviewed.

The checkout must fetch history (`fetch-depth: 0`): the bot reviews the branch against its base.

## Inputs

| Input | Default | Meaning |
| --- | --- | --- |
| `api-key` | — | Model key. Passed to Rigour as `RIGOUR_API_KEY`, never on a command line. |
| `provider` | `claude` | `claude`, `openai`, `openrouter`, `gemini`, `groq`, `mistral`, `together`, `deepseek`, `ollama`, or any OpenAI-compatible name with `base-url`. |
| `model` | provider default | e.g. `claude-sonnet-5-5`, or `anthropic/claude-sonnet-5.5` on OpenRouter. |
| `base-url` | — | API base URL for OpenAI-compatible providers. |
| `max-comments` | `2` | Inline comments at most per push. |
| `version` | `latest` | `@rigour-labs/cli` version. |

## What it posts

- **Inline comments:** at most `max-comments`, the most severe first (security and proven findings before heuristics). A finding is posted once; a later push does not repeat it. A finding about a changed function but rooted on an unchanged line is posted on the nearest changed line and says where the root cause is.
- **One summary comment**, edited in place on every push: the verdict, how many findings, how many changed functions the model reviewed by risk, how many were already reviewed before the PR, the model, and what the run cost.
- **The job summary** gets the same summary.

## What the model sees

With a key, Rigour reviews the pull request as one conversation: the diff with line numbers (lockfiles and build output left out), the riskiest changed functions with what to check in each, and the PR description. The model can read files and search the repository (read-only, never `.env` files, keys or credentials) before reporting. A finding is kept only if it names a line and identifiers the model actually read. If nothing in the PR is risky, no model call is made.

## Permissions

`contents: read` and `pull-requests: write`. The bot uses the workflow's `GITHUB_TOKEN`.
