# @rigour-labs/core

[![npm version](https://img.shields.io/npm/v/@rigour-labs/core?color=cyan)](https://www.npmjs.com/package/@rigour-labs/core)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**AI Agent Governance Engine — deterministic quality gates, drift detection, and LLM-powered deep analysis.**

The core library powering [Rigour](https://rigour.run) — 27+ quality gates, five-signal deep analysis pipeline, temporal drift engine, and AI agent DLP across TypeScript, JavaScript, Python, Go, Ruby, and C#/.NET.

> This package is the engine. For the CLI, use [`@rigour-labs/cli`](https://www.npmjs.com/package/@rigour-labs/cli). For MCP integration, use [`@rigour-labs/mcp`](https://www.npmjs.com/package/@rigour-labs/mcp).

## What's Inside

### 27+ Deterministic Quality Gates

**Structural:** File size, cyclomatic complexity, method count, parameter count, nesting depth, required docs, content hygiene.

**Security:** Hardcoded secrets, SQL injection, XSS, command injection, path traversal, frontend secret exposure.

**AI Drift Detection:**
- **Three-pass duplication drift** — MD5 exact → AST Jaccard (tree-sitter) → semantic embedding (all-MiniLM-L6-v2, 384D cosine). Catches `.find()` vs `.filter()[0]` — same intent, different implementation.
- **Hallucinated imports** — language-aware resolution for relative + package imports.
- **Phantom APIs** — non-existent stdlib/framework methods the LLM invented.
- **Style drift** — fingerprints naming, error handling, import style, quote preferences against project baseline.
- **Logic drift** — tracks comparison operators (>= → >), branch counts, return statements per function across scans.
- **Dependency bloat** — unused deps, heavy alternatives (moment→dayjs), duplicate purpose packages.
- **Context-window artifacts**, inconsistent error handling, promise safety, deprecated APIs.

**Agent Governance:** Multi-agent scope isolation, EWMA-based checkpoint supervision, context drift, retry loop breaker, memory & skills governance with DLP scanning.

### Five-Signal Deep Analysis Pipeline

Rigour's deep analysis is not a wrapper around a generic LLM. The model operates within a cage of deterministic facts:

1. **Extract** — five independent signal streams (AST facts, semantic embeddings, style fingerprints, logic baselines, dependency graphs) computed deterministically before the LLM sees anything.
2. **Interpret** — the model receives structured facts (not raw source), focuses on SOLID, design patterns, language idioms, architecture. Constrained input prevents hallucination.
3. **Verify** — every LLM finding is cross-referenced against all five signal streams. Wrong line numbers, phantom patterns, non-existent functions → discarded. Only verified findings with confidence scores reach the report.

Both model tiers (lite sidecar + pro code-specialized) are fine-tuned via the [DriftBench RLAIF pipeline](https://github.com/rigour-labs/driftbench) where the five signal streams serve as the teacher signal.

### Temporal Drift Engine (v5.1)

Cross-session trend analysis powered by EWMA and Z-score anomaly detection. Tracks three independent provenance streams (AI drift, structural, security) with separate trend directions. Reads from the SQLite brain for month-over-month analysis.

Key capabilities: per-provenance EWMA streams (alpha=0.3), Z-score anomaly detection (|Z| > 2.0), monthly/weekly rollups, semantic duplicate tracking, style + logic baseline evolution, human-readable narrative generation.

### Multi-Language Support

All gates support: TypeScript, JavaScript, Python, Go, Ruby, and C#/.NET.

### Two-Score System

Every failure carries a **provenance tag** (`ai-drift`, `traditional`, `security`, `governance`) and contributes to two sub-scores:

- **AI Health Score** (0–100) — AI-specific failures
- **Structural Score** (0–100) — Traditional code quality

### Fix Packets (v2)

Machine-readable JSON diagnostics with severity, provenance, file, line number, and step-by-step remediation instructions that AI agents can consume directly.

## Usage

```typescript
import { GateRunner } from '@rigour-labs/core';

const runner = new GateRunner(config);
const report = await runner.run(projectRoot);

console.log(report.status);    // 'PASS' or 'FAIL'
console.log(report.stats.score);     // 0-100
console.log(report.failures);  // Failure[]
```

### With Deep Analysis

```typescript
import { GateRunner } from '@rigour-labs/core';

const runner = new GateRunner(config);
const report = await runner.run(projectRoot, undefined, {
  enabled: true,
  pro: false,        // true for full-power model
  provider: 'local', // or 'claude', 'openai', etc.
});
```

## Documentation

**[Full docs at docs.rigour.run](https://docs.rigour.run)**

## License

MIT © [Rigour Labs](https://github.com/rigour-labs)
