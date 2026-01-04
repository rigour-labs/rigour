# 🩺 Fix Packet v2: High-Fidelity Refinement

The **Fix Packet v2** is the authoritative communication bridge between Rigour and an AI agent. It transforms abstract quality gate failures into a structured, machine-readable refinement protocol.

## 📋 Schema Definition

When a project fails a Rigour check, a `rigour-fix-packet.json` file is generated in the root.

```json
{
  "version": 2,
  "goal": "Achieve PASS state for all quality gates",
  "violations": [
    {
      "id": "ast-complexity",
      "gate": "ast",
      "severity": "high",
      "title": "Complexity Cap Exceeded",
      "details": "Function 'processData' has cyclomatic complexity of 15 (max: 10).",
      "files": ["src/parser.ts"],
      "metrics": {
        "current": 15,
        "max": 10
      },
      "instructions": [
        "Extract nested logic into a separate utility function.",
        "Replace the switch statement with a lookup table or polymorphic behavior."
      ]
    }
  ],
  "constraints": {
    "paradigm": "oop",
    "no_new_deps": true,
    "max_files_changed": 10,
    "do_not_touch": [
      ".github/**",
      "docs/**",
      "rigour.yml"
    ]
  }
}
```

## 🏗️ Technical Specifications

### `violations[]`
| Field | Type | Description |
|:---|:---:|:---|
| `id` | `string` | Unique identifier for the failure type. |
| `severity` | `enum` | `low`, `medium`, `high`, `critical`. |
| `metrics` | `object` | Raw data (e.g., line count, complexity score) for precise fixing. |
| `instructions` | `string[]` | Heuristic-based advice on how to resolve the specific violation. |

### `constraints`
| Field | Type | Description |
|:---|:---:|:---|
| `no_new_deps` | `boolean` | If true, the agent MUST NOT add entries to `package.json` or equivalent. |
| `do_not_touch` | `string[]` | Globs representing files the agent is forbidden from modifying. |
| `max_files_changed` | `number` | Abort threshold to prevent "Explosive Refactoring" (Thrash). |

---

## 🚦 The "Stateless" Refinement Protocol

Rigour follows a **Stateless** loop. Each iteration, the agent is provided a fresh Fix Packet. The agent does not need to remember history; it simply solves the current delta until the packet is empty.
