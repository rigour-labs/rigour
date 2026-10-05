# 🧪 AST-Based Analysis

Rigour uses Abstract Syntax Tree (AST) analysis to enforce production-grade engineering standards that simple regex pattern matching cannot catch.

## 🏗️ Technical Implementation

### Current Engine: TypeScript Compiler API
Rigour currently uses the official **TypeScript Compiler API** to parse and analyze source code. This allows for high-fidelity detection of code structures across both TypeScript and JavaScript projects.

| Language | Engine | Status |
|:---|:---|:---:|
| **TypeScript (.ts, .tsx)** | TS Compiler API | ✅ Stable |
| **JavaScript (.js, .jsx)** | TS Compiler API | ✅ Stable |
| **Python** | `python-ast` / `ruff` | 🧭 Planned |
| **Go** | tree-sitter | ✅ Stable |

### Type-aware analysis (`semantic_bugs`)
Most AST gates parse one file at a time. The `semantic_bugs` gate builds a `ts.Program` with the type checker, so it follows values through imports, destructuring (including `Promise.all`), reassignment and function parameters, and reports a defect only when both ends are resolved. Programs are built from the project's own modules (external libraries are skipped), in batches, which keeps a full scan of a ~2,000-file repository near 1.3 GB and a scoped run under a second. See [Configuration](./CONFIGURATION.md#semantic_bugs) for the rules and `rigour learn`.

## 📏 Enforced Metrics

### 1. Cyclomatic Complexity
**Statutory Limit**: 10 (Configurable)
Measured by counting branching points (`if`, `switch`, `while`, `for`, `&&`, `||`). High complexity correlates directly with high bug density and poor testability.

### 2. Class Density (SOLID)
**Statutory Limit**: 12 methods (Configurable)
Rigour flags classes that are becoming "God Objects". This forces the agent to extract logic into smaller, composed services.

### 3. Function Signatures
**Statutory Limit**: 5 parameters (Configurable)
Large parameter lists are a sign of poor abstraction. Rigour forces the use of options objects or better encapsulation.

---

## Deep Analysis Pipeline (v2.18+)

**New in v2.18**: A semantic analysis layer built on AST facts.

Deep analysis combines **AST extraction** with **LLM interpretation** to detect issues pure syntax trees cannot catch:

1. **AST Extracts Facts**: Functions, classes, error handling, concurrency, imports, testing patterns
2. **LLM Interprets Facts**: Checks 47 named categories across SOLID, design patterns, error handling, architecture, concurrency, and language idioms
3. **AST Verifies Findings**: Drops hallucinated results (references to non-existent entities)

The three-step pipeline is how a whole-repository `rigour check --deep` works. Reviewing a change works differently: the router picks the risky changed functions and the model reviews them with read-only access to the repository (see [Deep Analysis](./DEEP_ANALYSIS.md#how-a-cloud-model-reviews-a-change)).

**Categories checked** (whole-repository runs):
- SOLID Principles (SRP, OCP, LSP, ISP, DIP violations)
- Design Patterns (god classes, feature envy, shotgun surgery, data clumps)
- DRY (duplication, copy-paste code)
- Error Handling (empty catches, error swallowing, missing checks, panic in libraries)
- Concurrency (race conditions, goroutine leaks, missing context, mutex scope) — Go-specific
- Testing (test quality, test coupling, test duplication, missing coverage)
- Architecture (circular dependencies, package cohesion, API design, missing abstraction)
- Language Idioms & Naming Conventions
- Performance & Resource Management
- Code Smells (long files, magic numbers, dead code)

[Full deep analysis docs →](./DEEP_ANALYSIS.md)

---

## 🧭 Roadmap: Advanced AST Gates

We are researching the following "Engineering Patterns" for future release:
- **Import Boundary Enforcement**: Prevent circular dependencies and layer leaks.
- **Dead Code Detection**: Automated removal of unused exports and local variables.
- **Async Hygiene**: Ensuring `await` is used correctly and preventing unhandled promise rejections at the structural level.
