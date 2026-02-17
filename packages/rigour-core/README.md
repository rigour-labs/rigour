# @rigour-labs/core

[![npm version](https://img.shields.io/npm/v/@rigour-labs/core?color=cyan)](https://www.npmjs.com/package/@rigour-labs/core)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**Deterministic quality gate engine for AI-generated code.**

The core library powering [Rigour](https://rigour.run) — AST analysis, AI drift detection, security scanning, and Fix Packet generation across TypeScript, JavaScript, Python, Go, Ruby, and C#/.NET.

> This package is the engine. For the CLI, use [`@rigour-labs/cli`](https://www.npmjs.com/package/@rigour-labs/cli). For MCP integration, use [`@rigour-labs/mcp`](https://www.npmjs.com/package/@rigour-labs/mcp).

## What's Inside

### 23 Quality Gates

**Structural:** File size, cyclomatic complexity, method count, parameter count, nesting depth, required docs, content hygiene.

**Security:** Hardcoded secrets, SQL injection, XSS, command injection, path traversal.

**AI-Native Drift Detection:** Duplication drift, hallucinated imports, inconsistent error handling, context window artifacts, async & error safety (promise safety).

**Agent Governance:** Multi-agent scope isolation, checkpoint supervision, context drift, retry loop breaker.

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

const runner = new GateRunner(config, projectRoot);
const report = await runner.run();

console.log(report.pass);      // true or false
console.log(report.score);     // 0-100
console.log(report.failures);  // Failure[]
```

## Documentation

**[Full docs at docs.rigour.run](https://docs.rigour.run)**

## License

MIT © [Rigour Labs](https://github.com/rigour-labs)
