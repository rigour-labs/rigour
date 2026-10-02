# Rigour

[![npm version](https://img.shields.io/npm/v/@rigour-labs/cli?color=22d3ee&label=cli)](https://www.npmjs.com/package/@rigour-labs/cli)
[![npm downloads](https://img.shields.io/npm/dm/@rigour-labs/cli?color=2563eb&label=downloads)](https://www.npmjs.com/package/@rigour-labs/cli)
[![License: MIT](https://img.shields.io/badge/license-MIT-facc15.svg)](https://opensource.org/licenses/MIT)
[![MCP Registry](https://img.shields.io/badge/MCP-Listed-22c55e)](https://rigour.run)

**Code review that happens while your agent writes the code — before a pull request exists.**

Most review happens after the fact: a bot comments on a finished PR, someone fixes it, pushes again, waits again. Rigour moves review to where the code is written. Your coding agent (Claude Code, Cursor, Codex, Cline, Windsurf) checks its own work with Rigour before it says "done", so the PR arrives already reviewed. A small PR bot catches whatever is left.

Free and local by default. Bring your own model key only if you want one.

```bash
brew install rigour-labs/tap/rigour      # macOS and Linux
npm install -g @rigour-labs/cli          # or with npm; needs Node.js 22+
rigour review                            # review your uncommitted change
```

## How it works

```text
  while the agent writes            before you commit             on the pull request
 ┌────────────────────────┐   ┌──────────────────────────┐   ┌─────────────────────────────┐
 │ deterministic gates on │   │ the agent reviews the    │   │ reviews only what was not   │
 │ every edit; the agent's│ → │ risky functions Rigour   │ → │ reviewed before; at most 2  │
 │ own model reviews the  │   │ picks, answers what to   │   │ comments, one summary,      │
 │ riskiest changes       │   │ check, and records it    │   │ never repeated on a push    │
 └────────────────────────┘   └──────────────────────────┘   └─────────────────────────────┘
        no key needed                 no key needed              optional: your model key
```

1. **Gates on every edit.** Hooks run fast, deterministic checks as the agent writes: security patterns, hallucinated imports, phantom APIs, async safety, and bugs Rigour can prove by tracing values across files. No model, no network.
2. **The agent reviews the risky part.** Rigour ranks the functions a change touched — removed guards, data writes, paging, auth, money and time, concurrency, network calls — and gives the agent a short list with what to check in each. The agent's own model does the review (no extra cost), fixes what is real, and records what it checked. Editing a function after that puts it back on the list.
3. **The PR is a safety net.** In CI, Rigour reviews the pull request as a whole, skips everything already reviewed, and posts at most two precise comments. With a model key it reads the repository like a reviewer would — callers, callees, types — before it reports anything.

## Start

**Claude Code:** install the plugin. It adds the review before Claude finishes, a `/rigour:review` skill, and the MCP tools.

```text
/plugin marketplace add rigour-labs/rigour-plugin
/plugin install rigour@rigour-labs
```

**Any other agent** (MCP):

```json
{
  "mcpServers": {
    "rigour": { "command": "npx", "args": ["-y", "@rigour-labs/mcp@latest"] }
  }
}
```

Keep a version in the package name (`@latest`, or a major such as `@6`): with a bare `@rigour-labs/mcp`, npx runs any older copy installed globally instead.

Then ask it to *"review before you finish"*, or use the `rigour-pre-commit` prompt. It calls `rigour_review` (with `mode: "agent"`), fixes what it finds, and acknowledges each risky function with `rigour_review_ack`.

**Add the hooks** so this happens without asking:

```bash
npx @rigour-labs/cli init
npx @rigour-labs/cli hooks init --tool claude   # or cursor, cline, windsurf
```

To make the agent finish only after the risky functions are reviewed, set `hooks.require_review_ack: true` in `rigour.yml`.

**Working without an agent?**

```bash
rigour review                 # gates on your uncommitted change
rigour review-task            # the risky functions to look at, and what to check
rigour review-ack src/sync.ts syncOrders --verdict no_issue --note "cursor advances on every page"
```

## The PR bot

Copy [`examples/github/rigour-review.yml`](examples/github/rigour-review.yml) to `.github/workflows/`. Without a key it runs the gates only and nothing leaves the runner. With a key (a `RIGOUR_API_KEY` secret), a model reviews the riskiest parts of the PR:

```yaml
- uses: rigour-labs/rigour@main
  with:
    api-key: ${{ secrets.RIGOUR_API_KEY }}
    provider: openrouter                       # or claude, openai, gemini, groq, ...
    base-url: https://openrouter.ai/api/v1
    model: anthropic/claude-sonnet-5.5
```

To let the bot skip what your agents already reviewed, run `rigour review-export` and commit `.rigour/reviewed.json` (function hashes and verdicts only — no code, no notes).

## Your key, your cost

- **No key:** gates, the review task, the ledger, and the PR bot's gates all work. Nothing is sent anywhere.
- **With a key:** only the riskiest changed functions reach the model; a PR with nothing risky costs nothing. The model reads the repository with read-only tools that never open `.env` files, keys, or credentials.
- **What it cost, observed:** every model run records its real tokens and cost (the provider's own figure when it reports one). Studio shows the total, and what the router kept away from the model.

```bash
read -s K && npx @rigour-labs/cli settings set-key openrouter "$K" && unset K
rigour review --deep --provider openrouter --api-base-url https://openrouter.ai/api/v1 \
  --model-name anthropic/claude-sonnet-5.5
```

## Studio

```bash
npx @rigour-labs/cli studio
```

**Review › Pre-PR review** shows the functions reviewed and the defects fixed before a PR existed, what is still waiting, and the model spend Rigour actually observed. The rest of Studio maps agent work: context each agent received, gates and Fix Packets, lessons learned from fixes, and drift.

## Rules learned from your fixes

`rigour learn <fix-commit>` turns a fix into a rule for the same bug. A rule is kept only if it fires on the code before the fix, stays silent on the fixed code, and hits few other places; those places are listed for review. Learned rules live in `.rigour/rules/` and are reviewed like code.

```bash
rigour learn a1b2c3d --dry-run
rigour learn --agent-fixes       # rules from fixes your agents made to Rigour findings
```

## How we measure

Every claim about catching bugs is measured on the open [driftbench arena](https://github.com/rigour-labs/driftbench): real merged pull requests, reviewed at the commit a human reviewer saw, scored against the review comments developers actually acted on, with judged labels and confidence intervals. Repositories used to design a rule are never used to claim it works.

## Local first, team-ready

Rigour runs fully local with SQLite; nothing needs an account. For teams, PostgreSQL (with optional pgvector) shares approved knowledge, and local enforcement keeps working when it is unreachable. See [Enterprise & Teams](docs/ENTERPRISE.md).

## Quiet by default

A review only speaks when it can prove the defect: a value traced from where it enters to where it does harm, an import that resolves to nothing, a secret in the source, a model finding grounded in code it read. Heuristics (size, complexity, patterns that guess) are advisory: in `--json` for anyone who wants them, never failing a review, never posted on a PR, never blocking an agent. Turn them back on with `review.include_heuristics: true`.

Two database checks are advisory and off by default: a supabase-js read that no index in your migrations can serve, and a branch migration dated before the newest one on main. Turn them on with `gates.unindexed_reads` and `gates.migration_order` ([Configuration](docs/CONFIGURATION.md)).

Generated files are never reviewed. If a finding is wrong for your code, silence it for good:

```bash
rigour dismiss 3f9a1c0b7d2e4a51 --reason "test fixture token, never deployed"
```

Commit `.rigour/dismissed.json` and it stays quiet for the whole team and the PR bot.

Rigour also learns which checks your repository acts on. Every fixed or dismissed finding updates that check's precision here (a Beta posterior: fixed + 1 over fixed + dismissed + 2). An advisory check your team has dismissed at least five times, with precision under 25%, is muted. Proven checks never are. `rigour precision` shows the table.

## Guarantees and boundaries

- Checks and storage are local; a model is used only when you configure one.
- A model finding is kept only if it cites a line and identifiers the model actually read.
- Rigour enforces what passes through its hooks, MCP tools, or gateway; it cannot see work that bypasses them.
- Spend is observed per run; estimates are labelled as estimates.
- Anonymous usage telemetry is opt-in, asked once, never in CI, and never includes code, paths or repository names ([TELEMETRY.md](TELEMETRY.md)). `DO_NOT_TRACK=1` always wins.

## Documentation

| If you want to… | Start here |
| --- | --- |
| Install and run Rigour | [Quick Start](docs/QUICK_START.md) |
| Connect a coding agent | [Agent Integration](docs/AGENT_INTEGRATION.md) · [MCP Integration](docs/MCP_INTEGRATION.md) |
| Set up the PR bot | [PR Bot](docs/PR_BOT.md) |
| Configure models, the router, and deep review | [Deep Analysis](docs/DEEP_ANALYSIS.md) · [Configuration](docs/CONFIGURATION.md) |
| Understand a failed check | [Fix Packets](docs/FIX_PACKET.md) · [AST Gates](docs/AST_GATES.md) |
| Mediate MCP tools for agents | [MCP Integration](docs/MCP_INTEGRATION.md) |

## Build from source

```bash
pnpm install
pnpm build
pnpm test
```

---

**[Documentation](https://docs.rigour.run)** · **[Discussions](https://github.com/rigour-labs/rigour/discussions)** · **[Issues](https://github.com/rigour-labs/rigour/issues)**

MIT © [Rigour Labs](https://github.com/rigour-labs) · Built by [Ashutosh](https://github.com/erashu212)
