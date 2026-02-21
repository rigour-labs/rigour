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

All AI-native gates are **enabled by default** and support **multi-language detection** (TypeScript, JavaScript, Python, Go, Ruby, C#/.NET).

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
Detects imports referencing modules that don't exist — a common AI failure where models confidently generate import statements for fictional packages or file paths. Severity: `critical`. Provenance: `ai-drift`.

**Multi-language support:** Validates imports across JS/TS (`import`/`require`), Python (`import`/`from`), Go (`import`), Ruby (`require`/`require_relative`), and C# (`using`).

```yaml
gates:
  hallucinated_imports:
    enabled: true               # Default: true
    check_relative: true        # Verify relative imports resolve to real files
    check_packages: true        # Verify packages exist in manifest
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
Detects quality degradation within a single file when AI loses context mid-generation. Compares the top half vs bottom half of each file across six signals: comment density, function length, variable naming, error handling, empty blocks, and TODO density. Severity: `high`. Provenance: `ai-drift`.

```yaml
gates:
  context_window_artifacts:
    enabled: true               # Default: true
    min_file_lines: 100         # Only analyze files with 100+ lines
    degradation_threshold: 0.4  # 0-1, flag if degradation exceeds this
    signals_required: 2         # Need 2+ signals to flag a file
```

### `promise_safety` (v2.17+)
Detects unsafe async/error-handling patterns across all supported languages — a pattern where AI generates "happy-path only" code that silently swallows errors. Severity: `high`. Provenance: `ai-drift`.

**Multi-language checks:**

| Language | Patterns Detected |
|:---|:---|
| JS/TS | `.then()` without `.catch()`, `JSON.parse` without try/catch, `async` without `await`, `fetch` without error handling |
| Python | `json.loads` without try/except, `async def` without `await`, `requests`/`httpx` without error handling, bare `except: pass` |
| Go | Ignored error returns (`_`), `json.Unmarshal` without error check, `http.Get` without error check |
| Ruby | `JSON.parse` without `begin/rescue`, `Net::HTTP`/`HTTParty`/`Faraday` without `begin/rescue` |
| C#/.NET | `JsonSerializer` without try/catch, `HttpClient` without error handling, `async Task` without `await`, `.Result`/`.Wait()` deadlock risk |

```yaml
gates:
  promise_safety:
    enabled: true                    # Default: true
    check_unhandled_then: true       # .then() without .catch()
    check_unsafe_parse: true         # JSON.parse / json.loads without error handling
    check_async_without_await: true  # async functions that never await
    check_unsafe_fetch: true         # HTTP calls without error handling
```

### `deep` (v2.18+)

Semantic code analysis powered by LLMs. Detects architectural violations, design pattern issues, and language idioms using a three-step pipeline: AST extraction → LLM interpretation → AST verification. Requires API key or local model.

```yaml
gates:
  deep:
    enabled: true                             # Default: false
    provider: anthropic                       # anthropic, openai, local
    model: claude-sonnet-4-5-20250514         # Model to use
    agents: 1                                 # Parallel agents (cloud only)

    # LLM settings
    maxTokens: 4000
    temperature: 0.3
    timeoutMs: 30000

    # Categories to check (all enabled if omitted)
    checks:
      - solid                  # SRP, OCP, LSP, ISP, DIP violations
      - dry                    # Duplication, copy-paste code
      - design_patterns        # God classes, feature envy, etc.
      - error_handling         # Empty catches, swallowing, missing checks
      - language_idioms        # Language best practices, naming
      - test_quality           # Test coverage, assertion quality
      - architecture           # Circular deps, package cohesion, API design
      - code_smells            # Long files, magic numbers, dead code
      - concurrency            # Race conditions, goroutine leaks (Go-specific)
      - performance            # Inefficiency, resource leaks
      - naming                 # Naming conventions
      - resource_management    # Hardcoded config, resource cleanup
```

**Settings file** (`~/.rigour/settings.json`):

Store API keys and default provider:

```json
{
  "anthropic_api_key": "sk-ant-...",
  "openai_api_key": "sk-...",
  "deep_provider": "anthropic",
  "deep_model": "claude-sonnet-4-5-20250514",
  "deep_enabled": true,
  "deep_agents": 1,
  "deep_timeout_ms": 30000
}
```

**CLI Usage**:

```bash
rigour check --deep                          # Enable deep analysis
rigour check --deep --provider anthropic     # Use Anthropic API
rigour check --deep --provider openai        # Use OpenAI API
rigour check --deep --provider local         # Use local model
rigour check --deep --agents 3              # 3 parallel agents (cloud only)
```

[Full deep analysis guide →](./DEEP_ANALYSIS.md)

---

## Two-Score System (v2.17+)

Rigour now provides **two distinct scores** alongside the overall score:

| Score | What It Measures |
|:---|:---|
| **AI Health Score** (0–100) | Quality of AI-generated code — drift patterns, hallucinations, promise safety |
| **Structural Score** (0–100) | Traditional code quality — complexity, file sizes, security |
| **Overall Score** (0–100) | Combined weighted score across all gates |

Each failure also carries a **provenance tag** indicating its origin:

| Provenance | Meaning |
|:---|:---|
| `ai-drift` | Caused by AI losing context, hallucinating, or generating unsafe patterns |
| `traditional` | Standard code quality issues (complexity, file size, etc.) |
| `security` | Security vulnerabilities (secrets, injection, XSS) |
| `governance` | Agent governance violations (scope conflicts, loop detection) |

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

