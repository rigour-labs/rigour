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

### Quality Gates (27+ deterministic gates)

The core of Rigour — deterministic PASS/FAIL gates that catch what AI agents get wrong:

- **Hallucinated imports** — relative + package, language-aware resolution
- **Phantom APIs** — non-existent stdlib/framework methods the LLM invented
- **Deprecated API usage** — Node, Python, Web, Go, C#, Java
- **Security patterns** — hardcoded secrets, command injection, SQL injection, XSS, path traversal
- **Promise safety** — unhandled async, unsafe JSON.parse, floating fetch
- **Three-pass duplication drift** — MD5 exact → AST Jaccard (tree-sitter) → semantic embedding (all-MiniLM-L6-v2, 384D cosine). Catches `.find()` vs `.filter()[0]` — same intent, different implementation
- **Dependency bloat** — unused deps, heavy alternatives (moment→dayjs, axios→native fetch), duplicate purpose (two HTTP clients installed by different AI sessions)
- **Style drift** — fingerprints naming conventions, error handling patterns, import style, quote style against a project baseline. Flags when AI switches from camelCase to snake_case mid-project
- **Logic drift** — tracks comparison operators (>= silently became >), branch counts, return statements per function. Catches off-by-one mutations that still compile and pass tests
- **Context-window artifacts** — degradation patterns in files too long for the context window
- **Inconsistent error handling** — too many error strategies in one codebase
- **AST-level** — cyclomatic complexity, method count, nesting depth, function length
- **Test quality** — empty tests, tautological assertions, mock-heavy, snapshot abuse
- **Side-effect safety** — unbounded timers, recursive depth, resource lifecycle, retry loops

### Temporal Drift Engine (v5.1)

Cross-session trend analysis that answers: "Is AI getting worse?" separately from "Is code quality dropping?"

- **EWMA checkpoints** (alpha=0.3) — noise-resistant quality monitoring for long-running agents. One bad checkpoint doesn't tank the trend.
- **Z-score adaptive thresholds** — size-independent anomaly detection. A 100-failure enterprise project and a 2-failure hobby project both get correct alerts.
- **Per-provenance trending** — separate EWMA streams for AI drift, structural quality, and security. Pinpoints root cause instead of just "degrading."
- **Monthly/weekly rollups** with anomaly detection from SQLite brain data.
- **Semantic duplicate tracking** — embedding-based Pass 3 catches functions the AST misses (same intent, different implementation).
- **Style + logic baselines** — fingerprints stored in `.rigour/` directory, evolve with human-approved changes, flag AI mutations.

```bash
rigour check --deep    # Trend info appears automatically when enough history exists
rigour studio          # Visual dashboard with EWMA sparklines and score rings
```

### Deep Analysis (LLM-Powered RLAIF Pipeline)

Rigour does not wrap a generic LLM and hope for the best. It runs a **five-signal extraction → interpretation → verification pipeline** where the model is constrained by ground truth at every stage.

**Stage 1 — Multi-signal fact extraction (deterministic, no LLM):**

The extraction layer produces five independent signal streams before the LLM sees anything:

- **AST facts** — tree-sitter parses every file → function signatures, complexity metrics, control flow graphs, dependency relationships. Ground truth, no hallucination possible.
- **Semantic embeddings** — all-MiniLM-L6-v2 (384D) generates vector representations of every function body. Cosine similarity catches intent-level duplicates that AST alone misses (`.find()` vs `.filter()[0]`).
- **Style fingerprints** — naming convention distributions, error handling patterns, import styles, quote preferences computed per-file and compared against the project baseline stored in `.rigour/`.
- **Logic baselines** — comparison operators, branch counts, return statement counts, call sequences tracked per function across scans. Detects mutations that change behavior without changing structure.
- **Dependency graph** — unused deps, heavy alternatives map, duplicate purpose groups, import frequency analysis from source scan.

**Stage 2 — LLM interprets structured facts (not raw source):**

The model receives the five signal streams — not raw code. It focuses on SOLID principles, design patterns, language idioms, and architecture. The constrained input format prevents it from inventing non-existent code or hallucinating patterns.

**Stage 3 — Deterministic verification (no LLM):**

Every LLM finding is cross-referenced against the AST and all five signal streams. Claims about non-existent functions → discarded. Wrong line numbers → discarded. Phantom patterns → discarded. Only verified findings with confidence scores make it to the report.

This is why Rigour's deep analysis is not comparable to "ask an LLM to review code." The LLM operates within a cage of deterministic facts. It can reason, but it cannot hallucinate.

```bash
rigour check --deep           # Local sidecar (500MB one-time download, runs on any CPU)
rigour check --deep --pro     # Full-power model (900MB, code-specialized pretraining)
rigour check --deep --provider claude -k sk-ant-xxx  # Cloud BYOK (any provider)
rigour scan --deep            # Zero-config + deep (no rigour.yml required)
```

**Two model tiers:** The **lite** sidecar ships as the default — runs on any laptop CPU, no GPU needed. The **pro** model has code-specialized pretraining — companies host this for their team. Both are fine-tuned via the [DriftBench RLAIF pipeline](https://github.com/rigour-labs/driftbench) where the five signal streams serve as the teacher signal (SFT + DPO on real code quality findings). Cloud BYOK is available for any provider — your code context is sent to that API only when you explicitly opt in.

### Rigour Brain — Local Project Memory

Rigour gets smarter every time you use it. Every scan stores findings in a local SQLite database (`~/.rigour/rigour.db`). Patterns are reinforced when seen repeatedly, decay when absent, and promote to "hard rules" at high strength. Next deep scan checks local memory BEFORE calling the LLM — known patterns produce instant findings with zero inference cost.

```bash
rigour brain                          # Show memory status: DB size, patterns, hard rules
rigour brain --compact                # Prune old findings, weak patterns, VACUUM
rigour brain --compact --retain 30    # Keep only last 30 days
rigour brain --reset                  # Wipe all memory and start fresh
```

**How it works:** scan → store findings in SQLite → reinforce patterns (+0.15 per sighting) → decay stale patterns (-0.05 after 30 days unseen) → prune dead patterns (< 0.1) → promote to hard rules (≥ 0.9). The local GGUF model (lite or deep) provides general code knowledge; local memory provides project-specific history. Two sources of truth, code never leaves your machine.

**Compression:** Memory does not grow unbounded. Automatic decay prunes weak patterns every scan. `rigour brain --compact` deletes old findings beyond the retention window (default 90 days), removes patterns that never grew (strength < 0.3, seen < 3 times), cleans orphaned records, and runs SQLite VACUUM to reclaim disk space.

### Zero-Config Scan

Point Rigour at any repo — no config file needed. Auto-detects stack, applies all gates:

```bash
npx @rigour-labs/cli scan                     # AST-only, instant
npx @rigour-labs/cli scan --deep              # + local LLM analysis (lite, 500MB one-time)
npx @rigour-labs/cli scan --deep --pro        # + full deep model (900MB, code-specialized)
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
rigour check --deep                                      # + local LLM (lite: Qwen3.5-0.8B)
rigour check --deep --pro                                # + full deep model (Qwen2.5-Coder-1.5B)
rigour hooks init                                        # Install real-time hooks
rigour hooks check --files src/app.ts                    # Fast file check
rigour demo --cinematic --repo <github-url>              # Live demo on any repo
rigour brain                                             # Local memory status
rigour brain --compact                                   # Prune old data, reclaim disk
rigour doctor                                            # Diagnose install + deep readiness
```

## Deep Analysis: Exact Behavior

Rigour supports two deep-analysis paths:

### 1) Local deep (`--deep`, `--deep --pro`)
- `--deep` uses the **lite** model (Qwen3.5-0.8B, 500MB) — default sidecar, runs on any CPU
- `--deep --pro` uses the **deep** model (Qwen2.5-Coder-1.5B, 900MB) — code-specialized, higher accuracy
- Both are fine-tuned via RLAIF (SFT + DPO on code quality findings)
- First run downloads model assets once to `~/.rigour/models/`

### 2) Cloud deep (`--deep --provider ... -k ...`)
- Uses your configured provider API
- Code context can be sent to that provider
- No local model download required

Examples:

```bash
# Local lite (default — lightweight, any CPU)
rigour check --deep --provider local

# Local deep (full power — code-specialized, company-hosted)
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
    similarity_threshold: 0.75   # Jaccard on AST node multisets (tree-sitter)
    semantic_threshold: 0.85     # Embedding cosine similarity (Pass 3)
    semantic_enabled: true       # Toggle semantic embedding pass
  dependencies:
    detect_unused: true          # Flag deps with 0 imports
    detect_heavy_alternatives: true  # moment → dayjs, axios → fetch
    detect_duplicate_purpose: true   # Two HTTP clients installed
  style_drift:
    enabled: true
    deviation_threshold: 0.25    # 25% deviation from baseline triggers alert
  logic_drift:
    enabled: true
    track_operators: true        # >= became > (off-by-one)
    track_branches: true         # New if/else added or removed
    track_returns: true          # Return statements changed
```

Recommended policy for world-class quality:
- Block on `critical`/`high`
- Triage `medium`
- Track and prune repeated noisy patterns quickly

## Real-Time Hooks

Rigour uses a two-tier supervision model: inline hooks (<100ms, per file write) + checkpoint suite (2–5s, full gates). Hooks are the inline tier — they run inside your AI coding tool on every file write/edit.

**Two hooks per tool:**
- **Post-write hook** — quality checks (file size, secrets, hallucinated imports, command injection, governance)
- **Pre-write hook** — DLP credential interception (29 patterns, <50ms)

```bash
rigour hooks init                    # auto-detect tool, install hooks + DLP
rigour hooks init --tool all         # all tools at once
rigour hooks init --block            # exit code 2 on failures (strict mode)
rigour hooks init --no-dlp           # skip DLP hooks
rigour hooks check --files src/a.ts  # manual fast check
```

**Protocol details per tool:**

| Tool | Config | Quality Event | DLP Event | Protocol |
|------|--------|--------------|-----------|----------|
| **Claude Code** | `.claude/settings.json` | `PostToolUse` (matcher: `Write\|Edit\|MultiEdit`) | `PreToolUse` (matcher: `.*`) | JSON stdin/stdout, exit codes |
| **Cursor** | `.cursor/hooks.json` | `afterFileEdit` | `beforeFileEdit` | JSON stdin/stdout |
| **Cline** | `.clinerules/hooks/PostToolUse` | `PostToolUse` (filters `write_to_file`) | `PreToolUse` | Executable scripts, JSON stdin/stdout |
| **Windsurf** | `.windsurf/hooks.json` | `post_write_code` | `pre_write_code` | Command execution, JSON stdin |

`--block` returns exit code `2` on failures for blocking workflows. Pre-hooks (DLP) block by default.

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
| `rigour_deep_stats` | Local memory stats and score trends |

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
