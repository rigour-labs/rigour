# Rigour

[![npm version](https://img.shields.io/npm/v/@rigour-labs/cli?color=cyan&label=cli)](https://www.npmjs.com/package/@rigour-labs/cli)
[![npm downloads](https://img.shields.io/npm/dm/@rigour-labs/cli?color=blue)](https://www.npmjs.com/package/@rigour-labs/cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**AI Agent Governance. One command. Every agent.**

Rigour is the security and quality layer that sits between AI coding agents and your codebase. It governs three things no one else does:

1. **What goes IN** — DLP intercepts credentials before they reach any agent
2. **What comes OUT** — Quality gates catch hallucinated imports, unsafe patterns, and drift
3. **What gets PERSISTED** — Memory & skills governance prevents secrets from leaking into agent memory

Works with Claude Code, Cursor, Cline, Windsurf, and GitHub Copilot. One `rigour init` sets up everything.

## The Problem

AI agents are powerful but ungoverned. Today, when you paste an AWS key into Cursor or tell Claude your database password, that credential gets sent to the model, cached in conversation, and potentially stored in agent memory files (`.cursorrules`, `CLAUDE.md`, `.clinerules`). There is no interception layer. No audit trail. No governance.

Rigour fixes this.

## 30-Second Start

```bash
npx @rigour-labs/cli init
```

That's it. This command:
- Scans your project and creates `rigour.yml`
- Installs real-time hooks for every detected agent (Claude, Cursor, Cline, Windsurf)
- Enables DLP — credentials are intercepted before reaching agents
- Enables memory & skills governance — agents must use `rigour_remember` instead of native memory
- All local-first. Code never leaves your machine.

## What Rigour Does

### AI Agent DLP (Data Loss Prevention)

Every AI agent gets a **PreToolUse hook** that scans user input before the agent processes it.

**29 credential patterns** detected in real-time (<50ms):
- Cloud keys (AWS, GCP, Azure)
- API tokens (OpenAI, Anthropic, GitHub, Stripe, Twilio, Slack, SendGrid)
- Private keys (RSA, EC, OPENSSH, ED25519 — full multiline blocks)
- Database URLs (PostgreSQL, MongoDB, MySQL, Redis, AMQP)
- Bearer tokens and JWTs
- Base64/hex-encoded secrets (entropy detection)
- CI/CD tokens (Docker, NPM, PyPI, Sonar, Codecov, Sentry, Datadog)
- Generic password/secret assignments, .env format, URLs with embedded credentials

**Anti-evasion hardening:**
- Unicode normalization (zero-width chars, bidi control, homoglyphs)
- Shannon entropy detection for encoded/obfuscated secrets (>4.5 bits)
- JSON deserialization scanning (nested credentials in serialized objects)
- Deduplication with severity-based prioritization

**Compliance mapping:** SOC2-CC6.1, HIPAA-164.312, PCI-DSS-3.4/3.5/6.5, OWASP-A2, CWE-798, CIS-SCM, CIS-GCP, CIS-Azure

### Memory & Skills Governance

Agents write to native memory files — `.cursorrules`, `CLAUDE.md`, `.claude/skills/`, `.windsurf/memories/`. Rigour intercepts these writes and forces agents to use `rigour_remember` instead, where every value is DLP-scanned before persistence.

**Three enforcement layers:**

| Layer | What it blocks | Gate name |
|---|---|---|
| Memory | `CLAUDE.md`, `.clinerules`, `.windsurf/memories/` | `governance` |
| Skills | `.claude/skills/`, `.cursor/rules/`, `.windsurf/rules/` | `governance-skills` |
| DLP | Credentials in any governed file | `governance-dlp` |

**Recall is also gated.** If credentials were stored before DLP was installed, `rigour_recall` blocks them on read and tells the agent to clean up.

**Fully configurable in `rigour.yml`:**

```yaml
gates:
  governance:
    enabled: true              # master switch — false turns off all governance
    enforce_memory: true       # block native agent memory writes
    enforce_skills: true       # block native agent skills/rules writes
    block_native_memory: true  # hard block vs warning-only
```

### Quality Gates (40+ checks)

The original Rigour — deterministic PASS/FAIL gates that catch AI-generated code issues:

- Hallucinated imports (relative + package, language-aware)
- Phantom APIs (non-existent stdlib/framework methods)
- Deprecated API usage (Node, Python, Web, Go, C#, Java)
- Security patterns (hardcoded secrets, command injection, SQL injection, XSS, path traversal)
- Promise safety (unhandled async, unsafe JSON.parse, floating fetch)
- Duplication drift, context-window artifacts, inconsistent error handling
- AST-level: cyclomatic complexity, method count, nesting depth, function length
- Test quality (empty tests, tautological assertions, mock-heavy, snapshot abuse)

### Deep Analysis (LLM-Powered)

Optional LLM layer for SOLID principles, design patterns, language idioms, architecture review:

```bash
rigour check --deep           # Local Qwen2.5-Coder-0.5B (350MB one-time download)
rigour check --deep --pro     # Local Qwen2.5-Coder-1.5B (900MB)
rigour check --deep --provider claude -k sk-ant-xxx  # Cloud BYOK
rigour scan --deep            # Zero-config + deep (no rigour.yml required)
```

### Zero-Config Scan

Point Rigour at any repo — no config file needed. Auto-detects stack, applies all gates:

```bash
npx @rigour-labs/cli scan                     # AST-only, instant
npx @rigour-labs/cli scan --deep              # + local LLM analysis (350MB one-time)
npx @rigour-labs/cli scan --deep --pro        # + larger model (900MB, higher quality)
npx @rigour-labs/cli scan --deep -k sk-xxx    # + Claude API (BYOK)
```

### Live Demo on Any Public Repo

Clone a real GitHub repo, inject realistic AI drift, and watch Rigour catch it in real time:

```bash
npx @rigour-labs/cli demo --cinematic --repo https://github.com/fastapi/fastapi
```

**What happens:** Rigour clones the repo (shallow, into `/tmp`), detects the language (Python or TypeScript), injects realistic AI-generated code issues (hardcoded secrets, hallucinated imports, floating promises), simulates hooks catching each one live, runs full quality gates, then fixes the issues and shows the before/after score improvement. The original repo is never modified.

Supported injections by language:

| Language | Injections |
|---|---|
| **TypeScript/JS** | Hardcoded API secret, hallucinated npm package, unhandled async promise |
| **Python** | Wildcard CORS with credentials, PII logging in middleware, hardcoded config secrets |

```bash
rigour demo                                   # Synthetic project (built-in)
rigour demo --cinematic                       # Screen-recording optimized
rigour demo --cinematic --speed slow          # Slower pacing for presentations
rigour demo --hooks                           # Focus on real-time hook catches
```

## 5-Minute Start

```bash
# 1) Run once without install
npx @rigour-labs/cli scan

# 2) Initialize everything — config, hooks, DLP, governance
npx @rigour-labs/cli init

# 3) Full repository gates
npx @rigour-labs/cli check

# 4) Manually install hooks for a specific agent
npx @rigour-labs/cli hooks init --tool claude
```

## Install

### Option A: npx (fastest)

```bash
npx @rigour-labs/cli --version
```

### Option B: Homebrew

```bash
brew tap rigour-labs/tap
brew install rigour
rigour --version
```

### Option C: Global npm

```bash
npm install -g @rigour-labs/cli
rigour --version
```

## Core Commands

```bash
rigour scan                                              # Zero-config AST scan
rigour scan --deep                                       # Zero-config + local LLM deep analysis
rigour scan --deep -k sk-ant-xxx                         # Zero-config + Claude API
rigour init                                              # Set up config, hooks, DLP, governance
rigour check                                             # Full repository gates
rigour check --ci                                        # CI mode (minimal output)
rigour check --deep                                      # + local LLM analysis
rigour check --deep --pro                                # + larger local model
rigour hooks init                                        # Install real-time hooks
rigour hooks check --files src/app.ts                    # Fast file check
rigour demo --cinematic --repo <github-url>              # Live demo on any repo
rigour doctor                                            # Diagnose install + deep readiness
```

## Deep Analysis: Exact Behavior

Rigour supports two deep-analysis paths:

### 1) Local deep (`--deep`, `--deep --pro`)
- Uses local sidecar + local models
- Intended for local/private execution
- First run may download model assets

### 2) Cloud deep (`--deep --provider ... -k ...`)
- Uses your configured provider API
- Code context can be sent to that provider
- No local model download required

Examples:

```bash
# Local (force local even if API keys are configured)
rigour check --deep --provider local
rigour check --deep --pro --provider local

# Cloud
rigour settings set-key anthropic sk-ant-xxx
rigour check --deep --provider anthropic
```

## Accuracy And False Positives

Rigour is designed to reduce false positives while staying strict.

Current approach:
- Language-aware import validation (manifest + stdlib aware)
- Per-language resolution logic (not one regex for all stacks)
- Nearest-manifest resolution for monorepos where applicable
- Deep findings are treated separately from deterministic AST/static gates

You can tune precision in `rigour.yml`:

```yaml
gates:
  hallucinated_imports:
    enabled: true
    check_relative: true
    check_packages: true
    ignore_patterns:
      - "\\.css$"
      - "\\.svg$"
  duplication_drift:
    enabled: true
    similarity_threshold: 0.8
```

Recommended policy for world-class quality:
- Block on `critical`/`high`
- Triage `medium`
- Track and prune repeated noisy patterns quickly

## Real-Time Hooks

```bash
rigour hooks init
rigour hooks init --tool all
rigour hooks check --files src/a.ts,src/b.ts --block
```

Supported integrations:
- Claude Code
- Cursor
- Cline
- Windsurf

`--block` returns exit code `2` on failures for blocking workflows.

## CI

GitHub Actions minimal step:

```yaml
- run: npx @rigour-labs/cli check --ci
```

## MCP

Use Rigour as an MCP server — agents get quality gates, DLP scanning, governed memory, and deep analysis as tool calls:

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

**Key MCP tools:**

| Tool | What it does |
|---|---|
| `rigour_check` | Run quality gates on the project |
| `rigour_hooks_check` | Fast file check (<100ms) — also accepts `text` param for DLP scanning |
| `rigour_hooks_init` | Install hooks for any agent (DLP on by default) |
| `rigour_remember` | DLP-gated persistent memory (scans before storing) |
| `rigour_recall` | DLP-gated recall (blocks tainted memories) |
| `rigour_check_deep` | LLM-powered code review |
| `rigour_review` | PR diff analysis |
| `rigour_security_audit` | CVE scan on dependencies |

## Release-Ready Validation

Before cutting or announcing a release, run:

```bash
npm run verify:brain-packages
npm run verify:release
```

Then confirm all items in:

- [Release Checklist](./RELEASE_CHECKLIST.md)

## Troubleshooting

### `rigour --version` shows old version after brew upgrade

```bash
rigour doctor
which -a rigour
brew unlink rigour && brew link rigour
hash -r
```

If needed, remove global npm conflict:

```bash
npm uninstall -g @rigour-labs/cli
```

### Deep mode: sidecar package not found

Check platform package availability and scope access (`@rigour-labs/brain-*`).
Run `rigour doctor` to confirm local inference binary/model readiness.

### Deep mode: `spawn ... rigour-brain EACCES`

Set executable bit:

```bash
chmod +x <path-to-rigour-brain>
```

If needed, run:

```bash
rigour check --deep --provider local
```

Rigour will attempt managed sidecar reinstall and permission repair automatically.

### `ENOTFOUND registry.npmjs.org`

Network/DNS/proxy issue (not a gate finding). Fix registry access first.

## Documentation

- [Quick Start](./docs/QUICK_START.md)
- [Configuration](./docs/CONFIGURATION.md)
- [Deep Analysis](./docs/DEEP_ANALYSIS.md)
- [Accuracy Policy](./docs/ACCURACY.md)
- [MCP Integration](./docs/MCP_INTEGRATION.md)
- [OWASP Mapping](./docs/OWASP_MAPPING.md)
- [Fix Packet Spec](./docs/specs/FIX_PACKET_SCHEMA.md)
- [Docs Site](https://docs.rigour.run/)

## License

MIT © [Rigour Labs](https://github.com/rigour-labs)
