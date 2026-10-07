# Model review

Model review adds a language model to `rigour review` and `rigour check`. The deterministic
gates still run first. The model then looks at the change for defects the gates cannot prove,
and Rigour keeps only the findings that point at code the model was actually shown.

You choose the model on the command line, for each run:

- **A cloud model**, with your own API key (Anthropic, OpenAI, OpenRouter, Gemini and any
  OpenAI-compatible endpoint). This is the strong option.
- **A local model**, downloaded once and run on your machine. Nothing leaves the machine.

Nothing in `rigour.yml` turns model review on or picks a provider or key. A committed file
only tunes how a review runs (see [Settings in rigour.yml](#settings-in-rigouryml)).

## Model review or the reviewer

Rigour has two ways to put a model on a change. They are separate features.

| | Model review (this page) | [The reviewer](./REVIEWER.md) |
| --- | --- | --- |
| What runs the model | Rigour calls a provider API, or a local llama.cpp model | Your coding agents' own CLIs (Claude Code, Cursor, Codex), headless and read-only |
| Credentials | An API key, or none for a local model | The CLIs' existing logins; no API key |
| Turned on by | `--deep`, `--pro`, `--max` or `-k` on the run | `--reviewer` on the run, or `review.reviewer.enabled` in `rigour.yml` |
| Reads human review comments | No | Yes, checks every point against the code |
| Several judges, panel voting | No, one model | Yes (`--full`, `--panel`) |
| Runs in CI | Yes: the GitHub Action passes your key | No: the agent CLIs are on your machine, not the runner |

Use model review in CI and wherever you have a key but no agent CLIs. Use the reviewer on a
developer's machine before asking a person to review. A team can use both.

## Quick start

```bash
# Cloud: put the key in the environment (in CI, a secret), then ask for a deep review
export RIGOUR_API_KEY=sk-ant-...
rigour review --base main --deep --provider anthropic --model-name claude-sonnet-5-5

# Through OpenRouter, or any OpenAI-compatible endpoint
rigour review --base main --deep --provider openrouter --model-name anthropic/claude-sonnet-5.5

# Local: no key, no network after the first download
rigour review --deep      # lite tier
rigour review --pro       # deep tier
rigour review --max       # max tier
```

A key alone does not start a model review. `rigour review` runs a model only when the run has
`--deep`, `--pro`, `--max` or `-k`.

## Choosing cloud or local

When a run asks for a model, Rigour resolves a key. **If it finds one, the run is a cloud
review, even with `--pro` or `--max`.** Pass `--provider local` to force the local model when a
key is configured.

If you name a cloud provider (`--provider openai`) and no key is found, the run stops with a
usage error. It does not quietly fall back to the small local model, so a CI job with a missing
secret cannot report a review that never happened.

### Where the key comes from

The first of these wins:

1. `-k, --api-key <key>` on the command line.
2. The `RIGOUR_API_KEY` environment variable.
3. Your settings file, `~/.rigour/settings.json`: the key stored for the selected provider.

```bash
rigour settings set-key anthropic sk-ant-...       # stored with owner-only file permissions
rigour settings set-key openrouter sk-or-...
rigour settings set deep.defaultProvider openrouter
rigour settings set deep.defaultModel anthropic/claude-sonnet-5.5
rigour settings show                               # keys are masked
```

The provider is `--provider`, else `deep.defaultProvider` in your settings, else `anthropic`.
The settings file is looked up under that provider's name (`claude` reads the `anthropic` key,
`gpt` reads `openai`, `google` reads `gemini`). `--model-name` overrides `deep.defaultModel`, and
`--api-base-url` overrides `deep.apiBaseUrl`.

In CI, use `RIGOUR_API_KEY`. A key passed with `-k` is visible to other processes on the machine.

The MCP tools `rigour_check` and `rigour_check_deep` take the key as a tool argument. They do not
read `RIGOUR_API_KEY` or your settings file.

### Providers

`claude` and `anthropic` use the Anthropic SDK. Every other provider name uses the OpenAI SDK
against an OpenAI-compatible endpoint. These names have a built-in endpoint:

| Provider | Endpoint |
| --- | --- |
| `openai` | `https://api.openai.com/v1` |
| `gemini` | `https://generativelanguage.googleapis.com/v1beta/openai` |
| `groq` | `https://api.groq.com/openai/v1` |
| `mistral` | `https://api.mistral.ai/v1` |
| `together` | `https://api.together.xyz/v1` |
| `fireworks` | `https://api.fireworks.ai/inference/v1` |
| `deepseek` | `https://api.deepseek.com/v1` |
| `perplexity` | `https://api.perplexity.ai` |
| `openrouter` | `https://openrouter.ai/api/v1` |
| `ollama` | `http://localhost:11434/v1` |
| `lmstudio` | `http://localhost:1234/v1` |

Any other name (a self-hosted vLLM, a company gateway) needs `--api-base-url` and `--model-name`.

**Name the model.** `claude` and `anthropic` default to `claude-sonnet-5-5`, and the providers in
the table have a default fixed in the code; a provider with no default stops with an error asking
for `--model-name` rather than guessing one. Naming the model makes the run reproducible, and lets
Rigour price it.

**Ollama and LM Studio** need no key: `rigour review --deep --provider ollama --model-name
qwen2.5-coder:7b` reviews with the model your Ollama server runs, on this machine.

## How a cloud model reviews a change

`rigour review --deep` with a key reviews the change as one pull request, in one conversation:

1. **The router picks what is worth a paid model.** Each changed JavaScript or TypeScript
   function outside tests gets a risk score from cheap syntactic signals: data writes, auth,
   money or time, paging, concurrency, network calls, a removed guard (more conditions, returns
   or throws removed than added), and a verified team lesson that names code it uses. Size,
   nesting and being an exported async function add a little but never qualify a function on
   their own. Functions at or above `min_score` (default 1) are routed, at most `max_functions`
   (default 12). Functions an agent already recorded a review for, at their exact current text,
   are skipped, except in an independent review (`--independent`). A file the router cannot
   rank (another language, or a change outside any function) is always reviewed. If nothing is
   routed, no model is called.
2. **The model reads the whole diff**, riskiest functions first, with what to check in each.
   It also gets the pull request description (`--pr-body <path>`, or the pull request in a GitHub
   Actions event), callers in other changed files whose callee changed, the team's review lessons
   for the touched files, and, with `repo_rules: true`, the rules in `AGENTS.md`, `CLAUDE.md`,
   `.github/copilot-instructions.md` and `.cursor/rules/` that name a file or identifier the
   change touches. Once the diff passes 80,000 characters, the remaining files are listed for
   the model to read instead of sent.
3. **It looks things up before it reports.** The model has two read-only tools: `read_file`
   (at most 200 lines a call) and `grep` (tracked files, through `git grep`). Both stay inside the
   repository and refuse `.git/`, `.env*`, key and certificate files, `.npmrc`, `.netrc` and
   credentials files. The budget is 24 tool calls over 14 turns, then the model must answer.
4. **It reports at most five findings**, each anchored on a line the change added or changed.

With `agentic: false`, or with `rigour check <paths> --deep` (no diff), the cloud model reviews
file by file instead, four files at a time: with tools (12 calls, 8 turns per file) when
`agentic` is on, or twice with the reference material in opposite orders when it is off. Either
way a self-check then follows (below).

`rigour check --deep` with no paths is a different job: a whole-repository pass that sends
extracted facts about the code (functions, classes, imports, error handling), not source, and
checks the model's claims against those facts. `--agents <n>` spreads it over several cloud
connections. See [What Rigour checks](./CHECKS.md).

## How a local model reviews a change

The local tiers review each changed file with its numbered source, one file at a time. The
router does not apply: a local run costs nothing per call.

| Flag | Tier | Base model | Download | Per-call timeout | How it reviews |
| --- | --- | --- | --- | --- | --- |
| `--deep` | lite | Qwen2.5-Coder-0.5B | about 400-500 MB | 60 s | One pass per file |
| `--pro` | deep | Qwen2.5-Coder-1.5B | about 900 MB | 60 s | One pass per file |
| `--max` | max | Qwen2.5-Coder-7B | 4.7 GB; needs 16 GB of RAM | 240 s | Two passes with reference material, then a self-check |

The `--max` reference material is the lines the change removed, callees, callers and the pull
request description. Only `--max` (or a cloud key) can run `--diff-tests`, which runs changed
exported functions before and after the change.

**Where the files come from.** The engine is llama.cpp's `llama-cli` from a pinned GitHub
release (`ggml-org/llama.cpp`), checked against a SHA-256 in Rigour's source and installed in
`~/.rigour/bin/`. A working `llama-cli` already in `~/.rigour/bin/` or on `PATH` is used
instead. Models come from Hugging Face: Rigour first tries its fine-tuned model for the tier
(`rigour-labs/rigour-<tier>-v<version>-gguf`) and, if that cannot be downloaded, the stock
`Qwen2.5-Coder-*-Instruct` GGUF from the Qwen organisation, retrying the fine-tuned one at most
once a day. Each download is checked against the SHA-256 Hugging Face publishes and kept in
`~/.rigour/models/`. Rigour checks a small version file on Hugging Face at most once a day, with
a 5-second timeout; offline, it uses what is cached. The report names the model used and says
when it is the stock fallback.

`rigour deep pull` (add `--pro` for the deep tier) installs the engine and model ahead of time,
so a CI job can cache `~/.rigour/bin` and `~/.rigour/models`. It does not pull the max tier.
`rigour doctor` shows what is installed and whether `--deep` would go to the cloud.

## Grounding: why a finding can be trusted

The model proposes; Rigour checks. In a change review, a finding is dropped when:

- its confidence is below 0.3;
- it has no line;
- its file was not sent to the model, or its line is outside what was sent (in a whole-PR
  review, any line of a changed file or of a file the model read counts as sent);
- an identifier it quotes in backticks does not appear in the code the model was shown.

The report counts every drop by reason (`findings_rejected` in `--json`), so nothing is
dropped silently.

**Self-check.** On `--max` and on the per-file cloud review, the model re-reads all of a file's
findings against the code in one call and withdraws the ones that would not misbehave at
runtime. A self-check that fails to run, or a finding its reply does not mention, keeps the
finding. The whole-PR review has no self-check; its tool lookups and the grounding check do
that job.

## What blocks

A model finding that survives grounding is a proven finding: it blocks the review, the stop
hook and the push gate like any other proven gate, when it is on a line the change touched or
inside a function the change touched. A finding on an unchanged line inside a changed function
is attached to the nearest changed line. A model finding elsewhere in a changed file is shown
as context and never blocks. A finding you judge wrong is dismissed with
`rigour dismiss <key> --reason "..."` and does not block again (see
[During development](./DEVELOPMENT.md)).

If the model review was asked for and could not run (no engine, a rejected key, every call
failed), the review is `ERROR`, not `PASS`, and exits with code 3. If only some files failed, or
the run budget ran out, the run is `partial` and says how many files were not reviewed.

## Cost and tokens

A cloud run records input and output tokens and a cost in USD:

- OpenRouter reports the real cost of each call, and Rigour uses it.
- Otherwise Rigour prices tokens at list price, for the models it has checked prices for
  (`claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-4-5`). Any other model gets no cost,
  never a guess.

Where to see it: `rigour review --json` (the `deep` object: `model`, `input_tokens`,
`output_tokens`, `cost_usd`, `tool_calls`, and `router` with how many functions were ranked,
routed and already reviewed); `.rigour/deep-runs.jsonl`, one line per run, which Studio sums
into observed spend; and the PR comment the GitHub Action posts, which names the model and
cost. The prompt that repeats every turn of a tool conversation is marked for caching with
Anthropic models, directly or through OpenRouter.

## In CI

The GitHub Action runs `rigour review --base origin/<base> --json`, and adds
`--deep --provider <provider>` (plus `--model-name` and `--api-base-url` when set) only when its
`api-key` input is set. Without a key, only the deterministic gates run and no code leaves the
runner. Store the key as a `RIGOUR_API_KEY` secret. See [Pull requests and CI](./CI.md).

## Privacy

A cloud review sends the diff, the pull request description, the files the model asks to read
(never the secret files listed above) and the matching team lessons and repository rules to
your provider. A local review sends nothing; its only network use is the engine and model
downloads and the daily version check. See [Security, privacy and network use](./SECURITY.md).

## Settings in rigour.yml

These tune a model review once it runs. Rigour's defaults apply when they are unset.

| Setting | Default | What it does |
| --- | --- | --- |
| `gates.deep.max_tokens` | local 1024, cloud 4096 | Output tokens per model call. |
| `gates.deep.temperature` | `0.1` | Sampling temperature. |
| `gates.deep.timeout_ms` | local 60 s (`--max` 240 s), cloud 120 s | Timeout per model call. |
| `gates.deep.budget_ms` | none | Budget for a per-file review: files not started in time are skipped and counted, not an error. The single-conversation PR review ignores it. |
| `gates.deep.agentic` | `true` | Cloud only: let the model read the repository with `read_file` and `grep`. |
| `gates.deep.router.enabled` | `true` | Cloud only: send only the riskiest changed functions. |
| `gates.deep.router.min_score` | `1` | Risk score a function needs to be routed. |
| `gates.deep.router.max_functions` | `12` | Routed functions at most. |
| `gates.deep.review_lessons` | `verified` | Team review lessons that raise risk and are shown to the model: `verified`, `all` (adds candidates) or `off`. A candidate becomes a lesson on evidence: a later fix to the lines it named, a person's `rigour learn-reviews --promote <id>`, or the same point raised independently on pull requests by different authors ([REVIEWER.md](REVIEWER.md#how-it-learns)). |
| `gates.deep.repo_rules` | `false` | Show the model the rules from the repository's agent rules files that name what the change touches. |
| `gates.deep.intent_checks` | `false` | In a change review, ask the model one yes-or-no question at `await Promise.all([...])` sites with no failure handling: is one read optional while another is required? At most 10 sites per run. Off because the local models did not meet the zero-false-finding bar. |
| `gates.deep.checks.*` | all `true` | Categories for the whole-repository pass (`rigour check --deep` with no paths). |

The router settings and `review_lessons` also shape `rigour review-task` and the review receipt.
Every other setting is in the [configuration reference](./CONFIG_REFERENCE.md).
