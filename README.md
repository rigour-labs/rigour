# Rigour

[![npm version](https://img.shields.io/npm/v/@rigour-labs/cli?color=cyan&label=cli)](https://www.npmjs.com/package/@rigour-labs/cli)
[![cli downloads](https://img.shields.io/npm/dm/@rigour-labs/cli?color=blue&label=cli+downloads)](https://www.npmjs.com/package/@rigour-labs/cli)
[![mcp downloads](https://img.shields.io/npm/dm/@rigour-labs/mcp?color=blue&label=mcp+downloads)](https://www.npmjs.com/package/@rigour-labs/mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![MCP Registry](https://img.shields.io/badge/MCP-Listed-green)](https://rigour.run)
[![OWASP](https://img.shields.io/badge/OWASP-Project-red)](https://rigour.run)

---

## An AI agent shipped AWS credentials to a public repo. The bill was $47,000.

Rigour would have blocked it in **<100ms**.

AI coding agents — Claude, Cursor, Copilot, Cline — write code fast. Dangerously fast.  
They hallucinate imports. They leave TODO comments disguised as features. They write functions with complexity 47 and call it "done." And they will absolutely commit your production secrets if you let them.

**Rigour sits between your AI agent and your codebase.** Every file write. Every agent loop. Every line of code — checked before it ships.

No cloud. No telemetry. No opinions. Just **PASS** or **FAIL**.

```bash
npx @rigour-labs/cli init    # 60 seconds to set up
npx @rigour-labs/cli check   # deterministic gates, instant results
```

> *"We found Rigour after an agent leaked a database URL in a commit. It's now mandatory in every repo."*

---

## What AI agents do when you're not watching

```
Agent: "Done! All tests pass ✅"

Reality:
  src/auth.ts         → cyclomatic complexity: 47  (max: 10)
  src/config.ts       → AWS_SECRET_KEY="AKIA..."   (hardcoded)
  src/api/routes.ts   → // TODO: add auth here     (not done)
  src/db/client.ts    → 1,847 lines                (max: 500)
```

This is **Vibe Coding** — the agent optimizes for looking correct, not being correct.  
Every team using AI code generation hits this wall. Most don't catch it until production.

---

## How Rigour fixes it

Rigour introduces a **deterministic feedback loop** that the agent cannot bypass:

```
Agent writes code
      ↓
Rigour gates fire  →  FAIL?  →  Fix Packet (machine-readable JSON)
      ↓                               ↓
   PASS ✓                     Agent reads exact instructions
      ↓                               ↓
 Code ships                    Agent retries → PASS ✓
```

No human in the loop. No ambiguous "looks good to me." The agent gets told exactly what's wrong, on which line, and how to fix it — in JSON it can actually consume.

---

## The gates

### 🔐 Security — catches what agents routinely miss

| Gate | What it blocks |
|---|---|
| **Hardcoded Secrets** | AWS keys, API tokens, DB URLs, private keys — 29+ patterns |
| **SQL Injection** | Unsanitized query construction |
| **XSS** | Dangerous DOM manipulation |
| **Prototype Pollution** | Unsafe object merging |
| **CSRF** | Missing token validation |
| **Shannon Entropy** | Encoded/obfuscated secrets that regex misses |

> Zero false positives. Verified on 202-finding production audit (PicoClaw, 2025).

### 🏗️ Structural — enforces the standards agents skip

| Gate | Default limit |
|---|---|
| File size | 500 lines max |
| Cyclomatic complexity | 10 per function |
| Method count | 12 per class |
| Parameter count | 5 per function |
| Nesting depth | 4 levels |
| TODO/FIXME | Zero tolerance |
| Required docs | SPEC.md, ARCH.md, DECISIONS.md |

AST-based. Not heuristics. **TypeScript, JavaScript, Python** — with universal fallback.

### 🤖 Agent Governance — built for agentic workflows

| Gate | Purpose |
|---|---|
| **Context Drift** | Detects when the agent is diverging from the original spec |
| **Retry Loop Breaker** | Stops infinite agent retry spirals |
| **Checkpoint** | Supervises long-running executions |
| **Agent Team** | Scope isolation for multi-agent pipelines |
| **Memory Governance** | DLP-scans every agent memory write before persistence |

---

## Fix Packets — the reason agents actually fix things

Most tools tell humans what's wrong. Rigour tells **the agent** what's wrong, in a format it can consume:

```json
{
  "violations": [{
    "id": "ast-complexity",
    "severity": "high",
    "file": "src/auth.ts",
    "line": 45,
    "metrics": { "current": 47, "max": 10 },
    "instructions": [
      "Extract the nested conditional into a separate validateToken() function",
      "Replace switch statement with a strategy pattern — see ARCH.md"
    ]
  }],
  "constraints": {
    "no_new_deps": true,
    "do_not_touch": [".github/**", "docs/**"]
  }
}
```

The agent reads this. Fixes exactly what's flagged. Retries. **No human intervention.**

---

## Works with every AI IDE and agent

```json
{
  "mcpServers": {
    "rigour": {
      "command": "npx",
      "args": ["-y", "@rigour-labs/mcp"]
    }
  }
}
```

| IDE / Agent | Integration |
|---|---|
| **Claude Code** | ✅ Native MCP + CLAUDE.md |
| **Cursor** | ✅ MCP + `.cursorrules` |
| **Cline** | ✅ MCP + `.clinerules` |
| **Windsurf** | ✅ MCP + `.windsurfrules` |
| **GitHub Copilot** | ✅ MCP |
| **Codex** | ✅ Config-based |
| **Gemini** | ✅ Config-based |
| **CI/CD** | ✅ `rigour check --ci` |

One `rigour init` sets up hooks, MCP tools, rules files, DLP, and pattern indexing automatically.

---

## The Brain — local Bayesian learning

Rigour doesn't just check your code. It **learns your codebase**.

Every scan reinforces patterns. Patterns decay when absent. At `strength: 0.9`, they promote to hard rules. This is your project's own immune system — trained on your actual code, running entirely on your machine.

```
First week:  catches 12 violations
First month: catches 8 violations  ← learning your patterns
Third month: catches 3 violations  ← your agents have adapted
```

No two codebases have the same Rigour config. That's the point.

---

## Used in production

- **10,500+ monthly installs** across CLI and MCP — majority via AI IDE integrations
- **19,000+ total installs** across CLI and MCP packages
- **Organically forked by Alibaba iFlow** — they found us, we didn't pitch them
- **OWASP project** — submitted and listed
- **Cursor MCP directory** — listed
- **Zero false positives** on 202-finding production audit
- **43 releases** — v2.20.0, actively maintained

---

## Get started in 60 seconds

```bash
# Install
npx @rigour-labs/cli init

# Run gates
npx @rigour-labs/cli check

# Run with deep analysis (local GGUF sidecar — no API key needed)
npx @rigour-labs/cli check --deep

# Run with cloud analysis (BYOK)
npx @rigour-labs/cli check --deep --provider claude -k sk-ant-xxx

# Supervised agent loop
npx @rigour-labs/cli run -- claude "Refactor auth module"

# Open Studio dashboard
npx @rigour-labs/cli studio
```

---

## Configuration

```yaml
# rigour.yml — generated by rigour init
version: 1
preset: api           # auto-detected: ui | api | infra | data
paradigm: functional  # auto-detected: oop | functional | minimal

gates:
  max_file_lines: 500
  forbid_todos: true
  required_files: [docs/SPEC.md, docs/ARCH.md]
  ast:
    complexity: 10
    max_methods: 12
    max_params: 5
    max_nesting: 4
  security:
    enabled: true

commands:
  lint: "npm run lint"
  test: "npm test"

ignore: ["**/node_modules/**", "**/dist/**"]
```

---

## Architecture

Rigour is a pnpm monorepo — four packages, one purpose:

| Package | Purpose | Size |
|---|---|---|
| `@rigour-labs/core` | Gate engine, AST analysis, Fix Packet generation | ~2,400 SLOC |
| `@rigour-labs/cli` | `init`, `check`, `run`, `studio` | ~500 SLOC |
| `@rigour-labs/mcp` | MCP server — 26 tools for agent integration | ~400 SLOC |
| `@rigour-labs/studio` | React monitoring dashboard | Private |

**Stack:** TypeScript strict, web-tree-sitter, Zod, Vitest. CI across Ubuntu / macOS / Windows.

---

## Prior Art

The [Technical Specification](docs/SPEC.md) (published January 2026) establishes public disclosure of the **"Agentic Quality Gate Feedback Loop"** — the specific combination of deterministic local gates and agent-consumable Fix Packets described in this system.

---

## Documentation

| | |
|---|---|
| [Getting Started](https://docs.rigour.run/getting-started/installation) | Install and run in 60 seconds |
| [Configuration](https://docs.rigour.run/getting-started/configuration) | Customize your gates |
| [AST Gates](docs/AST_GATES.md) | Deep dive on structural analysis |
| [Fix Packet Schema](docs/FIX_PACKET.md) | v2 diagnostic format |
| [MCP Integration](https://docs.rigour.run/mcp/mcp-server) | Agent setup guides |
| [Philosophy](docs/PHILOSOPHY.md) | Why Rigour exists |
| [Enterprise CI/CD](docs/ENTERPRISE.md) | GitHub Actions patterns |

**Full docs → [docs.rigour.run](https://docs.rigour.run)**

---

## License

MIT © [Rigour Labs](https://github.com/rigour-labs)

Built by [Ashutosh](https://github.com/erashu212) — enforcing the engineering standards that AI agents skip.

---

*If Rigour caught something real in your codebase — [tell us](https://github.com/rigour-labs/rigour/discussions). That story matters more than any benchmark.*