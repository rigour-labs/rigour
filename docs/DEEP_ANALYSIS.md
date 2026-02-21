# Deep Analysis (LLM-Powered Code Quality)

Rigour's deep analysis layer adds **semantic code review** powered by large language models (Claude, GPT-4, or local models) on top of structural AST analysis. It identifies architectural violations, design pattern issues, and language idioms that pure syntax trees cannot detect.

---

## Overview

Deep analysis runs a **three-step pipeline**:

1. **AST Extraction**: Structured facts from source code (functions, classes, structs, interfaces, error handling, concurrency metrics, imports)
2. **LLM Interpretation**: Analyzes facts and identifies quality issues across 40+ categories
3. **AST Verification**: Validates that LLM findings reference real code entities (prevents hallucination)

**Critical insight**: Neither AST nor LLM works alone. AST provides structure but no semantics. LLM understands intent but can hallucinate. Together, with verification, they achieve accuracy impossible with either alone.

---

## How It Works

### Step 1: AST Extracts Structured Facts

The AST parser walks your codebase and extracts:

- **Functions/Methods**: Name, parameters, return type, complexity, line count, error handling patterns
- **Classes/Structs/Interfaces**: Name, methods, fields, inheritance, concrete/abstract, implemented interfaces
- **Error Handling**: Try/catch blocks, error types, error paths, panic sites, silent failures
- **Concurrency**: Goroutines, channels, mutexes, locks, race conditions, deadlock patterns
- **Imports**: Module names, internal vs external, circular dependencies, unused imports
- **Testing**: Test files, test functions, assertions, mocks, test coverage

### Step 2: LLM Interprets Facts and Identifies Issues

The LLM receives the extracted facts and identifies issues across **40+ categories**:

**SOLID Principles (5 checks)**
- `srp_violation` — Function or class with multiple reasons to change
- `ocp_violation` — Code brittle to extension without modification
- `lsp_violation` — Derived types don't satisfy base type contracts
- `isp_violation` — Clients forced to depend on unused interfaces
- `dip_violation` — High-level modules depend on low-level details

**Design Patterns (10 checks)**
- `god_class` — Class doing too much, violates SRP
- `god_function` — Function with mixed concerns, hard to test
- `feature_envy` — Function more interested in another object's data
- `shotgun_surgery` — One change requires edits scattered across files
- `long_params` — Function signature with too many parameters
- `data_clump` — Data members always used together, should be extracted
- `primitive_obsession` — Overusing primitives instead of small objects
- `lazy_class` — Class not earning its own existence
- `speculative_generality` — Unused abstraction added "just in case"
- `refused_bequest` — Subclass doesn't use inherited methods

**DRY (2 checks)**
- `dry_violation` — Logic duplicated across multiple places
- `copy_paste_code` — Identical code blocks suggesting extraction

**Error Handling (5 checks)**
- `empty_catch` — Catch block that swallows exceptions silently
- `error_swallowing` — Error returned but ignored by caller
- `missing_error_check` — Function call result not checked for errors
- `error_inconsistency` — Same error handled differently across codebase
- `panic_in_library` — Library code that panics instead of returning errors

**Concurrency (5 checks)** — Go-specific
- `race_condition` — Unsynchronized access to shared mutable state
- `goroutine_leak` — Goroutines spawned but never reaped
- `missing_context` — Goroutines launched without cancellation context
- `channel_misuse` — Channels not properly closed or synchronized
- `mutex_scope` — Mutex protecting wrong scope (too broad or too narrow)

**Testing (4 checks)**
- `test_quality` — Tests that don't verify behavior (empty assertions)
- `test_coupling` — Tests tightly coupled to implementation details
- `test_duplication` — Duplicated test setup/helpers
- `missing_test` — Public function without test coverage

**Architecture (4 checks)**
- `circular_dependency` — Modules/packages forming dependency cycle
- `package_cohesion` — Functions in package don't belong together
- `api_design` — Inconsistent or surprising API conventions
- `missing_abstraction` — Concrete types leaking instead of interfaces

**Language Idioms (2 checks)**
- `language_idiom` — Code violating language best practices
- `naming_convention` — Variable/function names not following conventions

**Performance & Security (3 checks)**
- `performance` — Inefficient algorithms or resource usage
- `resource_leak` — File handles, connections, memory not released
- `hardcoded_config` — Configuration values hardcoded instead of externalized

**Code Smells (6 checks)**
- `long_file` — File over line threshold (usually >300 lines)
- `magic_number` — Unnamed constant (number or string) appearing in logic
- `dead_code` — Unreachable or unused code
- `code_smell` — General code quality issue
- `inappropriate_intimacy` — Classes too tightly coupled
- `divergent_change` — File changed for multiple unrelated reasons

### Step 3: AST Verifies LLM Findings

Before surfacing a finding, the AST verification step checks:

- **Entity exists**: Referenced function/class/method is real and in scope
- **Threshold met**: If checking for length, does it exceed configured limit?
- **Scope validity**: The finding applies to actual code, not examples or comments
- **Type safety**: Referenced types match actual declarations

If verification fails, the finding is dropped. This prevents hallucinated issues like:
- "Function `validateUserInput()` violates SRP" — but the function doesn't exist
- "Class `PaymentProcessor` has 15 methods" — but it only has 8
- "Circular dependency: `auth` → `users` → `auth`" — but no cycle exists

---

## Language Support

Deep analysis supports **Go, TypeScript, JavaScript, Python, Rust, Java, and C#** with language-specific guidance.

### Go

Go support includes:

- **Structs & Receivers**: Method receiver types, pointer vs value semantics
- **Interfaces**: Concrete implementations, interface segregation
- **Goroutines**: Spawn sites, context propagation, cancellation
- **Channels**: Send/receive patterns, select blocks, deadlock risk
- **Defers**: Defer ordering, resource cleanup guarantees
- **Error Handling**: Explicit error returns, sentinel errors, error wrapping
- **Mutexes**: Lock scope, read/write separation, deadlock detection
- **Packages**: Unexported symbols, internal boundaries, import cycles

**Go-specific checks:**
- Mutex never held across channel sends (deadlock risk)
- Goroutines launched with `context.Background()` (missing cancellation)
- Undeferred resource cleanup (file handles, connections)
- Panic in library code (should return errors)
- Receiver type consistency (mix of pointer/value methods)

### TypeScript / JavaScript

- **Type Safety**: `as any`, unsafe type assertions, missing types
- **Async/Promises**: Unhandled promise rejections, missing await, floating promises
- **Modules**: Import cycles, star imports, unused dependencies
- **Error Handling**: Try/catch placement, error propagation
- **Testing**: Async test timeouts, unwaited promises in tests

### Python

- **Type Hints**: Missing annotations, `Any` overuse
- **Exception Handling**: Bare `except:`, exception swallowing
- **Context Managers**: Resources not using `with` statements
- **Async/Await**: Unwaited coroutines, blocking in async functions
- **Testing**: Fixture coupling, assertion clarity

### Rust

- **Ownership**: Unnecessary clones, move semantics violations
- **Error Handling**: Unwrap/panic in libraries, Result propagation
- **Lifetimes**: Missing lifetime annotations, borrow checker violations
- **Traits**: Trait object overhead, missing trait bounds

### Java / C#

- **Null Safety**: Nullable references, null checks missing
- **Resource Management**: AutoCloseable/IDisposable not used
- **Exception Handling**: Checked exceptions swallowed, over-broad catches
- **Inheritance**: Deep hierarchies, fragile base class problem

---

## Configuration

Configure deep analysis in `rigour.yml`:

```yaml
version: 1
preset: api
paradigm: functional

gates:
  deep:
    enabled: true
    provider: anthropic      # anthropic, openai, local
    model: claude-sonnet-4-5-20250514
    agents: 1                # Parallel agents (cloud providers only)

    # Categories to check (all enabled by default)
    checks:
      - solid
      - dry
      - design_patterns
      - language_idioms
      - error_handling
      - test_quality
      - architecture
      - code_smells
      - concurrency
      - performance
      - naming
      - resource_management

    # LLM configuration
    maxTokens: 4000
    temperature: 0.3
    timeoutMs: 30000

# Ignore paths from all gates (including deep)
ignore:
  - "**/generated/**"
  - "**/vendor/**"
  - "legacy/**"
```

### `provider`

- `anthropic` — Use Claude (via Anthropic API)
- `openai` — Use GPT-4 (via OpenAI API)
- `local` — Use local model via sidecar binary

### `model`

Model to use. Examples:
- `claude-opus-4-6` (Anthropic)
- `claude-sonnet-4-5-20250514` (Anthropic, recommended)
- `gpt-4-turbo` (OpenAI)
- `local:llama2` (Local, custom)

### `agents`

Number of parallel agents. Cloud providers (`anthropic`, `openai`) spawn multiple instances. Local mode always sequential (agents >1 ignored).

### `checks`

Array of check categories to enable. Omit to check all 40+ categories.

### `maxTokens`, `temperature`, `timeoutMs`

LLM parameters. Higher temperature = more creative but less reliable. Higher timeout accommodates slower local models.

---

## CLI Usage

Enable deep analysis with `--deep` flag:

```bash
# Run deep analysis with default provider (from settings or config)
rigour check --deep

# Use Anthropic API
rigour check --deep --provider anthropic

# Use OpenAI API
rigour check --deep --provider openai

# Use local model
rigour check --deep --provider local

# Parallel agents (cloud providers only)
rigour check --deep --agents 3

# Combined with other gates
rigour check --deep --ci
```

---

## Settings

Store API keys and defaults in `~/.rigour/settings.json`:

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

The CLI checks for API keys automatically and guides setup if missing.

---

## Multi-Agent Mode

Cloud providers support parallel deep analysis:

```bash
rigour check --deep --agents 3
```

This spawns 3 independent LLM agents, each analyzing different files. Each agent gets its own provider instance (e.g., 3 separate Anthropic API calls). Results are aggregated and deduplicated.

**Local mode** ignores the `--agents` flag and runs sequentially.

---

## Auto-Prerequisites

After `rigour init`, the CLI checks for:

1. **API keys** — Looks for `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `.rigour/settings.json`
2. **Local models** — Checks for sidecar binary or Ollama
3. **Configuration** — Validates `rigour.yml` gate settings

If missing, the CLI guides setup:

```
Deep analysis enabled but no API key found.

Options:
1. Set ANTHROPIC_API_KEY environment variable
2. Run: rigour auth anthropic
3. Edit: ~/.rigour/settings.json

Which would you like?
```

---

## Verification: How AST Prevents Hallucination

The verification step is critical. Without it, the LLM might report:

> "Class `OrderProcessor` violates SRP: handles payment, shipping, and notifications (3 concerns). Line 45."

But what if `OrderProcessor` is in a different file, or doesn't have those exact methods? The AST verifier catches this:

1. **Find entity**: Does `OrderProcessor` exist in scope?
2. **Check methods**: Does it actually have `processPayment()`, `shipOrder()`, `notifyCustomer()`?
3. **Verify concern count**: Are these really 3 separate concerns?
4. **Validate line**: Is the code at line 45?

If any check fails, the finding is dropped. This is why the pipeline works: **structure (AST) validates semantics (LLM)**.

---

## Example Output

Running `rigour check --deep` produces structured findings:

```json
{
  "violations": [
    {
      "id": "deep-analysis",
      "severity": "high",
      "category": "srp_violation",
      "file": "src/auth/jwt.ts",
      "line": 34,
      "message": "Function validateToken mixes concerns: token validation, cache lookup, and error logging",
      "verified": true,
      "instructions": [
        "Extract cache lookup into separate validateTokenFromCache() helper",
        "Move logging to middleware layer",
        "Return structured errors instead of logging"
      ]
    },
    {
      "id": "deep-analysis",
      "severity": "medium",
      "category": "missing_test",
      "file": "src/payment/processor.go",
      "line": 12,
      "message": "Public function ProcessRefund lacks test coverage",
      "verified": true,
      "instructions": [
        "Add test_processor.go with coverage for ProcessRefund",
        "Test success path, error cases, and edge cases"
      ]
    }
  ]
}
```

Each finding includes:
- `category` — One of the 40+ check types
- `verified` — AST confirmed this finding is real (not hallucinated)
- `instructions` — Agent-consumable remediation steps
- `severity` — `critical`, `high`, `medium`, `low`, or `info`

---

## Common Patterns

### Extracting a God Class

**Finding**: `god_class` in `UserManager`

**LLM message**: "UserManager handles authentication, profile management, permission checks, and email notifications — 4 unrelated concerns."

**AST verification**: ✓ UserManager has 28 methods covering all 4 areas

**Fix instructions**:
1. Extract email logic → `EmailService`
2. Extract permission checks → `PermissionValidator`
3. Rename `UserManager` → `UserAuthenticator` (single concern)
4. Compose the extracted services

### Detecting Missing Error Checks

**Finding**: `missing_error_check` in Go

**LLM message**: "Line 45: `json.Unmarshal(data, &config)` — error return ignored"

**AST verification**: ✓ Unmarshal called, return value not assigned or checked

**Fix instructions**:
1. Add error check: `if err != nil { return err }`
2. If error should be handled locally, provide context
3. Consider wrapping: `return fmt.Errorf("parsing config: %w", err)`

---

## Performance Considerations

Deep analysis is slower than structural gates (AST-only):

- **Fast gates** (AST only): <500ms per file
- **Deep analysis**: 1–5 seconds per file (depends on model and file size)

For CI/CD:

```bash
# Fast path: structural gates only
rigour check

# Deep path: full analysis (nightlies, pre-deploy)
rigour check --deep

# Parallel multi-agent analysis
rigour check --deep --agents 4  # Faster for large codebases
```

Local models are slower but fully private:

```bash
rigour check --deep --provider local  # Run locally, no API calls
```

---

## Troubleshooting

### "Deep analysis enabled but no model found"

**Solution**: Set provider and model in config or via CLI:

```bash
rigour check --deep --provider anthropic
```

Or configure in `rigour.yml`:

```yaml
gates:
  deep:
    enabled: true
    provider: anthropic
    model: claude-sonnet-4-5-20250514
```

### "API key rejected"

**Solution**: Verify key in `~/.rigour/settings.json` or environment:

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
rigour check --deep
```

### "Too many hallucinated findings"

**Likely cause**: LLM generating issues that don't exist in code.

**Solution**: Increase verification threshold or reduce LLM temperature:

```yaml
gates:
  deep:
    temperature: 0.1  # More conservative
```

This reduces creativity but improves accuracy.
