# OWASP Top 10 for LLM-Generated Code — Rigour Coverage

How Rigour's deterministic quality gates map to the [OWASP Top 10 Risks for LLM-Generated Code (2025 v2)](https://owasp.org/www-project-top-10-for-large-language-model-applications/) published by SonarQube.

> Rigour catches these risks deterministically at file-write and check time. Core gates run locally; if deep cloud mode is enabled, code context can be sent to your configured provider.

---

## Coverage Matrix

| # | OWASP Risk | Rigour Gate(s) | Coverage |
|---|---|---|---|
| 1 | **Injection Flaws** — SQL injection, command injection, XSS in generated code | `security-patterns` — SQL injection (string concatenation in queries), command injection (`exec`, `eval`, `child_process`), XSS (`innerHTML`, `dangerouslySetInnerHTML`, `document.write`), eval with user input | **Strong** |
| 2 | **Insecure Authentication & Session Management** — hardcoded credentials, weak auth | `security-patterns` — catches hardcoded API keys (`sk-`, `ghp_`, `AKIA`), passwords, tokens, private keys, and secrets in source | **Strong** |
| 3 | **Sensitive Data Exposure** — secrets, PII, API keys committed to code | `security-patterns` — regex-based detection of secret patterns, private keys, connection strings | **Strong** |
| 4 | **Insecure Dependencies** — hallucinated packages, typosquatting, outdated deps | `hallucinated-imports` — resolves every import against `node_modules` and flags packages that don't exist; `dependency` gate for outdated/vulnerable deps | **Strong** |
| 5 | **Improper Error Handling** — missing try/catch, unhandled promises, bare throws | `promise-safety` — detects floating promises (no await/catch), bare `.then()` without `.catch()`; `inconsistent-error-handling` — flags mixed error patterns | **Strong** |
| 6 | **Insecure Output Handling** — unescaped HTML, unsanitized responses | `security-patterns` — detects `res.send(req.*)` reflection, user input in templates/HTML, `eval()` with user input, `innerHTML` assignment, `dangerouslySetInnerHTML` | **Strong** |
| 7 | **Denial of Service Vulnerabilities** — unbounded loops, resource exhaustion, regex DoS | `security-patterns` — ReDoS detection (dynamic regex from user input, nested quantifiers); `ast` gate — cyclomatic complexity limits, max nesting depth | **Strong** |
| 8 | **Insufficient Input Validation** — missing schema validation, type coercion | `security-patterns` — detects `JSON.parse` on raw input without schema, `as any` type assertions; `ast` gate — structural analysis; `context-window-artifacts` — truncated validation logic | **Strong** |
| 9 | **Overly Permissive Code** — excessive privileges, broad CORS, wildcard permissions | `security-patterns` — detects `cors({ origin: '*' })`, `0.0.0.0` bindings, `chmod 777`, wildcard `Access-Control-Allow-Origin` headers | **Strong** |
| 10 | **Inadequate Code Quality** — dead code, duplication, god files, incomplete implementations | `duplication-drift` — detects copy-paste drift; `file-size` — enforces max lines per file; `content-check` — forbids TODO/FIXME; `context-window-artifacts` — catches truncated/repeated code blocks; `ast` — complexity enforcement | **Strong** |

---

## Coverage Summary

| Level | Count | Risks |
|---|---|---|
| **Strong** | 10 | All 10 OWASP LLM code risks |
| **Partial** | 0 | — |
| **None** | 0 | — |

**10 out of 10 OWASP LLM code risks have Strong coverage** via Rigour's deterministic quality gates.

---

## AI Drift Detection (Unique to Rigour)

Beyond the OWASP Top 10, Rigour detects **AI-specific code generation failures** that no traditional SAST tool catches:

| AI Drift Pattern | Rigour Gate | What It Catches |
|---|---|---|
| Hallucinated packages | `hallucinated-imports` | LLMs invent package names that don't exist (e.g., `ai-data-magic`) |
| Context window artifacts | `context-window-artifacts` | Truncated functions, repeated code blocks from context overflow |
| Floating promises | `promise-safety` | AI generates async calls without await or error handling |
| Duplication drift | `duplication-drift` | Copy-paste code across files when the LLM loses context |
| Incomplete implementation | `content-check` | TODO/FIXME markers the AI leaves behind |
| Inconsistent error handling | `inconsistent-error-handling` | Mixed patterns (try/catch in some places, bare throws in others) |

---

## Real-Time Enforcement via Hooks

Rigour doesn't just scan after the fact — with `rigour hooks init`, these checks run **in real time** as AI agents write code:

```
Agent: Write → src/auth.ts
[rigour/hook] CRITICAL [security-patterns] src/auth.ts:3
  → Possible hardcoded secret or API key

Agent: Write → src/data-loader.ts
[rigour/hook] HIGH [hallucinated-imports] src/data-loader.ts:2
  → Import 'ai-data-magic' does not resolve to an existing package
```

Supported tools: **Claude Code, Cursor, Cline, Windsurf**.

---

## References

- OWASP Top 10 for LLM-Generated Code (2025 v2) — SonarQube
- [Deterministic Quality Gates for AI-Generated Code](https://zenodo.org/records/18673564) — Singh, A. (Rigour Labs)
- [Rigour Documentation](https://docs.rigour.run)
- [GitHub Repository](https://github.com/rigour-labs/rigour)
