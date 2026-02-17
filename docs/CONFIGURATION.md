# ⚙️ Configuration Guide (`rigour.yml`)

Rigour is controlled by a `rigour.yml` file in your root directory.

## Schema Overview

```yaml
version: 1
preset: ui        # ui, api, infra, data
paradigm: oop    # oop, functional, minimal

gates:
  max_file_lines: 300
  forbid_todos: true
  forbid_fixme: true
  required_files:
    - docs/SPEC.md
    - docs/ARCH.md
  
  # Structural (AST) Analysis
  ast:
    complexity: 10      # Max cyclomatic complexity
    max_methods: 12     # Max methods per class
    max_params: 5       # Max parameters per function

commands:
  lint: "npm run lint"
  test: "npm test"
  typecheck: "npx tsc --noEmit"

output:
  report_path: "rigour-report.json"

# Ignore specific paths from all gates
ignore:
  - "**/generated/**"
  - "**/vendor/**"
  - "legacy/**"
```

## Gate Definitions

### `max_file_lines`
Enforces the **Single Responsibility Principle** by capping file length. Large files are usually a sign of "God Objects" or "Spaghetti Code".

### `forbid_todos` / `forbid_fixme`
Zero tolerance for technical debt markers. Engineering is finished when the code is clean, not when a comment is left for later.

### `ast.complexity`
Uses AST traversal to calculate **Cyclomatic Complexity**. It counts branches (if, for, while, case, etc.). Functions with complexity > 10 are difficult to test and maintain.

### `ast.max_methods`
Ensures classes stay focused. If a class has more than 10-12 methods, it should likely be split into multiple smaller services.

### `commands`
Any shell command that returns a non-zero exit code will cause the Rigour check to fail. This is where you integrate your existing CI tools.

---

## AI-Native Drift Detection Gates (v2.16+)

These gates detect failure modes unique to AI code generation — patterns that only exist because LLMs lose context, hallucinate, or generate code from scratch each session.

### `duplication_drift`
Detects when AI generates near-identical functions across files because it doesn't remember what it already wrote. Groups functions by normalized body hash and flags duplicates spanning multiple files. Severity: `high`.

```yaml
gates:
  duplication_drift:
    enabled: true               # Default: true
    similarity_threshold: 0.8   # 0-1, how similar bodies must be
    min_body_lines: 5           # Ignore trivial functions
```

### `hallucinated_imports`
Detects imports referencing modules that don't exist — a common AI failure where models confidently generate import statements for fictional packages or file paths. Severity: `critical`.

```yaml
gates:
  hallucinated_imports:
    enabled: true               # Default: true
    check_relative: true        # Verify relative imports resolve to real files
    check_packages: true        # Verify npm packages exist in package.json
    ignore_patterns:            # Skip asset imports
      - '\\.css$'
      - '\\.svg$'
```

### `inconsistent_error_handling`
Detects when the same error type is handled differently across the codebase — typically caused by multiple agent sessions each writing error handling from scratch. Classifies strategies (rethrow, swallow, log, return-null, etc.) and flags types with too many variants. Severity: `high`.

```yaml
gates:
  inconsistent_error_handling:
    enabled: true               # Default: true
    max_strategies_per_type: 2  # Flag if >2 different handling patterns
    min_occurrences: 3          # Need 3+ catch blocks to analyze
    ignore_empty_catches: false # Count empty catches as a strategy
```

### `context_window_artifacts`
Detects quality degradation within a single file when AI loses context mid-generation. Compares the top half vs bottom half of each file across six signals: comment density, function length, variable naming, error handling, empty blocks, and TODO density. Severity: `high`.

```yaml
gates:
  context_window_artifacts:
    enabled: true               # Default: true
    min_file_lines: 100         # Only analyze files with 100+ lines
    degradation_threshold: 0.4  # 0-1, flag if degradation exceeds this
    signals_required: 2         # Need 2+ signals to flag a file
```

---

## Severity-Weighted Scoring

Rigour scores your codebase 0–100, with deductions weighted by failure severity:

| Severity | Deduction | Examples |
|:---|:---|:---|
| `critical` | 20 pts | Hardcoded secrets, SQL injection, hallucinated imports |
| `high` | 10 pts | Duplication drift, context window artifacts, XSS |
| `medium` | 5 pts | Cyclomatic complexity, structural violations |
| `low` | 2 pts | File size limits |
| `info` | 0 pts | TODO/FIXME comments (tracked but free) |

This ensures the score reflects what actually matters — 5 TODO comments cost 0 points, while a single hardcoded API key costs 20.

---

## Ignore Paths

The `ignore` array allows you to exclude specific files or directories from **all gates**.

```yaml
ignore:
  - "**/generated/**"
  - "**/vendor/**"
  - "legacy/**"
  - "**/*.generated.ts"
```

### Pattern Syntax

Rigour uses **glob patterns** to match files:

| Pattern | Matches |
|---------|---------|
| `**/folder/**` | `folder` at any depth (e.g., `src/folder/`, `packages/app/folder/`) |
| `folder/**` | `folder` at **root only** |
| `**/*.ext` | All files with `.ext` extension |
| `path/to/file.ts` | Specific file |

> [!IMPORTANT]
> Use `**/` prefix to match directories at any depth. For example, `**/node_modules/**` matches both `node_modules/` and `frontend/node_modules/`.

### Default Ignores

Rigour automatically ignores these patterns (merged with your custom ignores):

- `**/node_modules/**`
- `**/dist/**`
- `**/build/**`
- `**/*.test.*` / `**/*.spec.*`
- `**/__pycache__/**`
- `**/.git/**`
- `**/package-lock.json`
- `**/pnpm-lock.yaml`

### Context-Specific Ignores

For the context mining gate, use `ignored_patterns`:

```yaml
gates:
  context:
    ignored_patterns:
      - "legacy/**"
      - "*.config.js"
```

