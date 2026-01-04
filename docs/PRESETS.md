# Rigour Presets & Paradigms

Rigour uses **Role Presets** and **Paradigm Detection** to apply appropriate quality gates for your project.

## Role Presets

Tech-agnostic presets based on your project's function.

| Preset | Use Case | Key Gates |
|:---|:---|:---|
| **ui** | Frontend/UI Engineers | `max_file_lines: 300`, Component modularity |
| **api** | Backend Services | `max_file_lines: 400`, SOLID enforcement |
| **infra** | IaC/DevOps | `max_file_lines: 300`, Runbook requirements |
| **data** | Data/ML Pipelines | `max_file_lines: 500`, Reproducibility focus |

## Paradigms

Coding style detection that layers on top of role presets.

| Paradigm | Detection Markers | Key Gates |
|:---|:---|:---|
| **oop** | `class`, `interface`, `extends`, `private/public` | Max methods: 10, Max inheritance: 3 |
| **functional** | `export const`, `reduce(`, `.pipe(`, `compose(` | Max function lines: 40, Max nesting: 3 |
| **minimal** | Default fallback | Basic hygiene only |

## Auto-Discovery

When you run `rigour init`, Rigour automatically detects:
1. **Role** from package.json deps, file markers (e.g., `next.config.js` → `ui`)
2. **Paradigm** from code patterns (e.g., `class` heavy → `oop`)

```bash
# Zero-config (auto-detect)
rigour init

# Explicit
rigour init --preset api --paradigm oop
```
