# Fix Packet Schema v2 (Frozen)

**Status**: Stable / Frozen
**Version**: 2.0.0
**Context**: The "Fix Packet" is the authoritative feedback object passed from Rigour to an AI Agent when a check fails. It is designed to be stateless and deterministic.

## JSON Schema

```json
{
  "type": "object",
  "properties": {
    "version": { "type": "integer", "const": 2 },
    "goal": { "type": "string", "default": "Achieve PASS state for all quality gates" },
    "violations": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": { "type": "string", "description": "Unique violation ID" },
          "gate": { "type": "string", "description": "Gate name (e.g., complexity, structure)" },
          "severity": { "type": "string", "enum": ["low", "medium", "high", "critical"] },
          "title": { "type": "string" },
          "details": { "type": "string" },
          "files": { "type": "array", "items": { "type": "string" } },
          "hint": { "type": "string" },
          "instructions": { "type": "array", "items": { "type": "string" } },
          "metrics": { "type": "object", "description": "AST metrics (e.g., complexity: 15)" }
        },
        "required": ["id", "gate", "severity", "title", "details"]
      }
    },
    "constraints": {
      "type": "object",
      "properties": {
        "protected_paths": { "type": "array", "items": { "type": "string" } },
        "do_not_touch": { "type": "array", "items": { "type": "string" } },
        "max_files_changed": { "type": "integer" },
        "no_new_deps": { "type": "boolean", "default": true },
        "allowed_dependencies": { "type": "array", "items": { "type": "string" } },
        "paradigm": { "type": "string", "enum": ["oop", "functional"] }
      }
    }
  },
  "required": ["version", "violations"]
}
```

## Field Definitions

### `violations`
A list of specific rule failures.
- **id**: A machine-readable ID (e.g., `max-lines-001`).
- **instructions**: Step-by-step pseudo-code or prompt injections to help the agent fix the issue.
- **metrics**: Precise numbers (e.g., "Current complexity is 15, Max is 10").

### `constraints`
Runtime boundaries enforced during the *next* attempt.
- **protected_paths**: Files the agent MUST NOT edit (e.g., `package.json`, `rigour.yml`).
- **no_new_deps**: If `true`, the agent cannot run `npm install` or import new libraries.
- **paradigm**: If set to `functional`, the agent should prefer pure functions over classes.
