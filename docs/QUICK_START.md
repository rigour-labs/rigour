# 🚀 Quick Start Guide

Get Rigour running in your project in less than 60 seconds.

## 1. Installation

Rigour is designed to be used via `npx` so you always have the latest version.

```bash
# Initialize Rigour in your project
npx @rigour-labs/cli init
```

## 2. Auto-Discovery

Rigour will automatically scan your project and detect its **Role** (UI, API, Infra, Data) and **Paradigm** (OOP, Functional). It creates a `rigour.yml` tailored to your environment.

## 3. The Quality Loop (Mandatory for Agents)

Don't just run your AI agent. Run it in a **Rigour Loop**. This ensures that if the agent writes messy code, Rigour will catch it and force a refactor before the task is considered done.

```bash
# Example: Refactoring with Claude Code
npx @rigour-labs/cli run -- claude "refactor the payment service"
```

### The three moments (`rigour hooks init`)

`rigour hooks init` (also run by `rigour setup`) installs Rigour at the moments that matter, for Claude Code:

| Moment | What runs | What happens on a problem |
| --- | --- | --- |
| Every edit | Fast checks on the file | The agent sees it at once |
| Before the agent says "done" | The whole branch against main: findings to fix, code the branch added that nothing uses, a merge conflict with main, mentions of files the branch deleted | The agent keeps working (at most three times); a turn that changed nothing is not reviewed again |
| Before `git push` | The same, plus your project's own formatter, linter, type checker and related tests, and what a change made redundant (from your project's own TypeScript). `rigour hooks init` also installs git's own `pre-push` hook, so every tool and the terminal go through the same gate (`rigour hooks selftest` proves it with a real push) | The push is blocked with one line per failure |
| After `git push` (if `review.reviewer.enabled`) | The reviewer: your coding agent's CLI, read-only, checks every point of every human review against the code, what a fix left behind, every read the change adds, then new findings. It runs in the background on the pushed commit, only when the branch has an open, non-draft pull request | `rigour review --status` shows the verdict; `rigour review --reviewer --full` is the hard stop before asking a person to review |

Already set up before the push gate existed? `rigour hooks init` never overwrites your hook settings, so run `rigour hooks init --force` once to add it.

## 4. Manual Check

You can run the quality gates manually at any time:

```bash
npx @rigour-labs/cli check
```

## 5. Explain Failures

If you get a failure, use `explain` to get actionable bullets:

```bash
npx @rigour-labs/cli explain
```

---

### 💡 Next Steps
- [Configuration Guide](./CONFIGURATION.md) - Customize your quality gates.
- [AST Analysis](./AST_GATES.md) - Learn how structural analysis works.
- [Agent Integration](./AGENT_INTEGRATION.md) - Multi-agent support (Cursor, Cline, Claude Code, etc).

