# 📄 Rigour Technical Specification: The Agentic Feedback Loop

**Version:** 1.0.0  
**Author:** Ashutosh (Rigour Labs)  
**Date:** January 4, 2026  
**Status:** Published (v1.0.0 Open Source)

---

## 1. Abstract
Rigour is a local-first engineering supervisor for Autonomous AI Agents. It addresses the "Vibe Coding" anti-pattern—where agents generate code that superficially works but violates structural, qualitative, and architectural standards—by implementing a stateless, deterministic quality-gate feedback loop.

## 2. The Core Invention: The Handshake Loop
The primary innovation is the **Agent-Machine Handshake**. Unlike typical linters which are run by humans, Rigour is designed to be consumed by agents via:

1.  **Handshake Protocol (.mdc / .md)**: Instructing the agent to self-verify before task completion.
2.  **Stateless Execution**: Running checks on the current filesystem state without requiring agent history.
3.  **Actionable Fix Packets (JSON)**: Translating complex engineering failures (SRP violations, hygiene issues) into prioritized, specific refactoring tasks the agent can immediately act upon.

## 3. Architecture
Rigour operates as a middleman between the **Agent** and the **Codebase**:

```text
User -> Agent -> [RIGOUR GATE] -> Codebase -> [RIGOUR FEEDBACK] -> Agent
```

### Components:
- **Core**: The gate engine and file discovery logic.
- **CLI**: The human/agent interface for running loops (`init`, `check`, `run`).
- **MCP**: The Model Context Protocol implementation for native integration into LLM desktops.

## 4. Prior Art Statement
This document and the associated repository (`erashu212/rigour`) establish public disclosure of the "Agentic Quality Gate Feedback Loop" as of January 2026. This publication serves as prior art to prevent third-party patenting of the specific combination of automated local gates and agent-specific fix packets described herein.

---
© 2026 Ashutosh / Rigour Labs. Distributed under the MIT License.
