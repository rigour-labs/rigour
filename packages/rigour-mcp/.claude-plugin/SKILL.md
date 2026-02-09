# Rigour Governance Skills

Rigour provides meta-cognitive governance tools to ensure AI agents stay aligned with engineering standards, project context, and brand identity during long-running coworking tasks.

## Skills

### `rigour_checkpoint`
Record a quality checkpoint during long-running agent execution. Use periodically (every 15-30 min) to enable drift detection and quality monitoring. Essential for coworking mode.

**Parameters:**
- `cwd` (string, required): Absolute path to the project root.
- `progressPct` (number, required): Estimated progress percentage (0-100).
- `summary` (string, required): Brief description of work done since last checkpoint.
- `qualityScore` (number, required): Self-assessed quality score (0-100).
- `filesChanged` (array of strings): List of files modified since last checkpoint.

---

### `rigour_agent_register`
Register an agent in a multi-agent session. Use this at the START of agent execution to claim task scope and enable cross-agent conflict detection.

**Parameters:**
- `cwd` (string, required): Absolute path to the project root.
- `agentId` (string, required): Unique identifier for this agent (e.g., 'marketing-pro', 'sales-bot').
- `taskScope` (array of strings, required): Glob patterns defining the files/directories this agent will work on.

---

### `rigour_check`
Run all configured quality gates (Lint, Test, AST, etc.) on the project. Call this before completing a task to verify overall quality.

**Parameters:**
- `cwd` (string, required): Absolute path to the project root.

---

### `rigour_get_fix_packet`
If gates fail, call this to retrieve a prioritized 'Fix Packet' containing detailed instructions on how to resolve the violations.

**Parameters:**
- `cwd` (string, required): Absolute path to the project root.

---

### `rigour_remember`
Persist critical instructions or project-specific conventions that should be remembered across sessions.

**Parameters:**
- `cwd` (string, required): Absolute path to the project root.
- `key` (string, required): Unique key for the memory.
- `value` (string, required): The instruction or context to remember.
