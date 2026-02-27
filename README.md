# Rigour

[![npm version](https://img.shields.io/npm/v/@rigour-labs/cli?color=cyan&label=cli)](https://www.npmjs.com/package/@rigour-labs/cli)
[![npm downloads](https://img.shields.io/npm/dm/@rigour-labs/cli?color=blue)](https://www.npmjs.com/package/@rigour-labs/cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Rigour is a quality gate system for AI-generated code.

It runs where AI mistakes happen:
- At file-write time (hooks)
- Before merge/deploy (`rigour check`)

If your standard is production-grade code from agents, Rigour is built for that workflow.

## Why Teams Use Rigour

- Deterministic gates (repeatable pass/fail)
- AI-drift detection (hallucinated imports, unsafe async patterns, duplication drift)
- Security-pattern checks for common high-risk classes
- Hook + CI + MCP integration in one stack
- Local-first operation with optional cloud deep analysis

## 5-Minute Start

```bash
# 1) Run once without install
npx @rigour-labs/cli scan

# 2) Initialize config + docs
npx @rigour-labs/cli init

# 3) Full repository gates
npx @rigour-labs/cli check

# 4) Install real-time hooks for your agent/editor
npx @rigour-labs/cli hooks init
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
rigour scan
rigour init
rigour check
rigour check --ci
rigour check --deep
rigour check --deep --pro
rigour hooks init
rigour hooks check --files src/app.ts
rigour doctor
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

Use Rigour as an MCP server for agentic workflows:

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
