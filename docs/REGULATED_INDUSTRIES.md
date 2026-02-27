# Rigour for Regulated Industries: Strategic Positioning

**Context:** As AI coding agents become standard in enterprise development, regulated industries (healthcare, finance, government, defense) face a unique challenge — they must adopt AI for velocity while maintaining audit trails, compliance evidence, and deterministic quality guarantees that regulators demand.

Rigour is uniquely positioned to bridge this gap. Here's how.

---

## The Regulatory Gap in AI-Assisted Development

Regulated industries already have compliance frameworks (SOC 2, HIPAA, PCI-DSS, FedRAMP, ISO 27001). But none of these frameworks address a critical new risk: **AI-generated code quality is non-deterministic.**

When a human developer writes code, the review process is well-understood — peer review, static analysis, CI gates. When an AI agent writes code, the output varies per session, hallucinates dependencies, loses context mid-generation, and optimizes for "appearing correct" over "being auditable."

Regulators haven't caught up yet. But the liability hasn't changed. If an AI agent introduces a security vulnerability into a healthcare system, the engineering team is still responsible.

**Rigour's thesis:** The team that can *prove* their AI-generated code meets deterministic quality standards has a regulatory moat.

---

## Industry-Specific Positioning

### Healthcare (HIPAA, FDA 21 CFR Part 11, HITRUST)

**The pain:** Healthcare software must demonstrate that code handling PHI (Protected Health Information) follows secure coding practices. FDA-regulated software (SaMD — Software as a Medical Device) requires documented evidence of code quality throughout the development lifecycle.

**Rigour's value:**

- **Hallucinated Imports gate** catches AI-generated references to non-existent security libraries — a critical failure when the code *thinks* it's encrypting PHI but the encryption module doesn't exist.
- **Async & Error Safety gate** detects unhandled errors in HTTP calls and JSON parsing across Python, C#, and JS — the exact pattern that leads to silent data loss in EHR integrations.
- **Provenance tracking** (`ai-drift` vs `traditional` vs `security`) provides audit evidence showing *which* quality issues originated from AI generation vs human coding.
- **Severity-weighted scoring** with the two-score system (AI Health + Structural) gives compliance officers a single dashboard metric to monitor AI code quality over time.
- **Deterministic, local-first execution** keeps core gates on the development machine. For HIPAA-constrained teams, use local deep mode and disallow cloud provider mode by policy.

**Positioning statement:** *"Rigour provides deterministic quality evidence for AI-generated code in healthcare systems — proving to auditors that every AI contribution was validated against security, structural, and safety gates before it touched production."*

### Financial Services (SOC 2, PCI-DSS, SOX, DORA)

**The pain:** Financial institutions face intense scrutiny on code quality, especially for systems handling transactions, customer data, and regulatory reporting. SOX compliance requires documented controls over financial reporting systems. DORA (Digital Operational Resilience Act) in the EU now explicitly requires ICT risk management for third-party and automated systems.

**Rigour's value:**

- **Security gates** (hardcoded secrets, SQL injection, command injection) catch the exact vulnerabilities that PCI-DSS auditors flag — and with `security` provenance tags, the audit trail shows these were caught *before* deployment.
- **Context Window Artifacts gate** is critical for financial systems — it catches the pattern where AI generates clean validation logic at the top of a file but degrades into sloppy error handling at the bottom, exactly where edge cases in transaction processing live.
- **Fix Packet schema (v2)** provides machine-readable, deterministic audit artifacts — every quality failure is documented with severity, file, line number, and remediation guidance. This is audit evidence that SOX and DORA require.
- **Supervised mode** (`rigour run`) creates a complete log of agent iterations, gate results, and human arbitration decisions — a governance trail showing that AI code generation was supervised, not autonomous.
- **Multi-language support** (JS/TS, Python, Go, C#) covers the full stack of a typical fintech — React frontends, Python ML models, Go microservices, and C# legacy systems.

**Positioning statement:** *"Rigour transforms AI-assisted development from a compliance risk into a compliance advantage — generating deterministic quality evidence that satisfies SOC 2, PCI-DSS, and DORA audit requirements while accelerating delivery velocity."*

### Government & Defense (FedRAMP, NIST 800-53, IL4/IL5, CMMC)

**The pain:** Government agencies adopting AI code generation face the strictest scrutiny. NIST 800-53 SA-11 (Developer Security Testing) requires evidence that code has been tested against known vulnerability patterns. CMMC (Cybersecurity Maturity Model Certification) requires documented secure development practices.

**Rigour's value:**

- **Local-first with enforceable provider policy** — Rigour supports fully local execution. In IL4+/air-gapped environments, run without cloud providers and disable outbound deep-provider configuration.
- **Agent Team Governance** (multi-agent scope isolation, checkpoint supervision, handoff verification) provides the chain-of-custody documentation that defense contracts require — proving which agent modified which files, with human approval at each step.
- **Retry Loop Breaker** prevents runaway AI agents from burning compute or creating infinite modification loops — an operational safety concern in government cloud environments with strict resource allocation.
- **Provenance-tagged Fix Packets** serve as NIST 800-53 SA-11 evidence — documenting that AI-generated code was tested against security gates, structural gates, and AI-specific drift gates before acceptance.

**Positioning statement:** *"Rigour is the quality firewall for AI-assisted development in government environments — deterministic gates, chain-of-custody governance, and deployment controls that support local-only operation when required by NIST, FedRAMP, and CMMC policies."*

---

## Cross-Industry Differentiators

### Why Rigour vs. Traditional Static Analysis (SonarQube, ESLint, etc.)

| Dimension | Traditional Tools | Rigour |
|:---|:---|:---|
| **Designed for** | Human developers | AI agents |
| **Feedback format** | Human-readable reports | Machine-readable Fix Packets |
| **AI-specific detection** | None | 5 dedicated AI-drift gates |
| **Provenance tracking** | No | Every failure tagged with origin |
| **Multi-agent governance** | No | Scope isolation, handoff verification |
| **Execution model** | Cloud/CI | Local-first, cloud-optional deep mode |
| **Feedback loop** | Post-commit (CI fails) | Pre-commit (agent self-heals) |

### The Compliance Narrative

Traditional compliance story: *"We run SonarQube in CI and review results manually."*

Rigour compliance story: *"Every AI-generated code change passes through deterministic quality gates before it enters the codebase. Each failure is documented with severity, provenance, file, and line number. Agent governance ensures multi-agent workflows have scope isolation and human arbitration. Processing can be constrained to local-only execution where policy requires it."*

The second story is what auditors in 2026 want to hear.

---

## Suggested Go-To-Market Actions

1. **Create a "Compliance Evidence" export** — A CLI command (`rigour export-audit`) that generates a PDF/JSON audit package summarizing gate results, provenance breakdown, AI Health Score trends, and governance events over a time period. This is the artifact compliance officers hand to auditors.

2. **Publish industry-specific preset configs** — `rigour init --preset healthcare`, `--preset fintech`, `--preset government` that pre-configure stricter thresholds (e.g., healthcare forbids any `critical` security findings, government enables full agent governance).

3. **Write a whitepaper: "Deterministic Quality Gates for AI-Generated Code in Regulated Environments"** — Position Rigour as the thought leader at the intersection of AI development and regulatory compliance. Target CISOs and VP Engineering at enterprises adopting AI coding tools.

4. **Partner with compliance platforms** — Integrate Rigour's audit output with GRC tools (Vanta, Drata, Sprinto) so that Rigour gate results automatically feed into SOC 2 / HIPAA evidence collection.

5. **Seek NIST/CISA recognition** — Submit Rigour's approach to NIST's AI Risk Management Framework (AI RMF) as a reference implementation for "AI code quality governance." This is early-mover positioning that creates credibility.

6. **Build a "Regulatory Readiness Score"** — An aggregate metric combining AI Health Score, Structural Score, security gate pass rate, and governance compliance into a single number that maps to regulatory frameworks. Example: "Your codebase has a Regulatory Readiness Score of 87/100 for HIPAA compliance."

---

## Summary

Rigour isn't just a code quality tool — it's **compliance infrastructure for the AI-assisted development era.** Every regulated industry is going to need deterministic proof that AI-generated code meets their standards. Rigour provides that proof today, while the rest of the market is still figuring out the problem.

The companies that adopt Rigour now get two things: faster AI-assisted development velocity *and* a regulatory moat that their competitors will spend years building.
