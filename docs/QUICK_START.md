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

