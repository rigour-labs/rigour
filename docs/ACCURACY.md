# Accuracy and False-Positive Policy

This document defines how Rigour maintains high signal quality while staying strict enough for production use.

## Objectives

- Keep deterministic gates reliable across supported languages.
- Minimize false positives without reducing security coverage.
- Track regressions with explicit release criteria.

## Quality Model

Rigour findings are evaluated on two dimensions:
- **Precision**: How often flagged findings are truly valid issues.
- **Recall (targeted)**: For known seeded issues, how often the gate catches them.

For user trust, precision is the primary KPI for default gate behavior.

## Baseline Requirements

Before a release, run gate test suites and curated fixture sets for supported languages.

Minimum expectations:
- No known critical false-positive regressions in default config.
- Hallucinated-imports and security-pattern gates must pass language regression fixtures.
- Monorepo/path-resolution fixtures must be included for JS/TS and at least one non-JS language.

Run the maintained benchmark suite:

```bash
pnpm accuracy:check
```

## Severity-Aware Acceptance Policy

- `critical` / `high` findings: prioritize precision fixes first.
- `medium` findings: acceptable only with clear remediation guidance and low noise.
- `info` findings: may be noisy but must remain non-blocking.

## False-Positive Response SLA

When users report false positives:
1. Reproduce with a minimal fixture.
2. Add a regression test.
3. Patch gate logic or defaults.
4. Release note must reference the regression class fixed.

Target turnaround:
- Critical blocker false positive: next patch release.
- High-impact developer workflow noise: next minor release.

## Recommended Team Operating Mode

For high-confidence adoption:
- Block CI on `critical` and `high`.
- Warn on `medium` initially.
- Reclassify or tune gates only after fixture-backed evidence.

## Configuration Safety Rules

Do not weaken standards globally to silence noise. Prefer scoped tuning:

```yaml
gates:
  hallucinated_imports:
    ignore_patterns:
      - "^@generated/"
  duplication_drift:
    similarity_threshold: 0.85
```

Principle: narrow exclusions over broad disables.

## Release Checklist (Accuracy)

- [ ] Gate tests green for touched modules.
- [ ] New regression tests added for each fixed false-positive class.
- [ ] Docs updated when behavior changes.
- [ ] Changelog explicitly calls out accuracy-impacting changes.

## Public Accuracy Contract

Rigour is local-first and deterministic for core gates. Deep analysis can run local or cloud provider mode. Claims in docs must always reflect this behavior.

JS/TS style checks exclude exported Next.js route methods, JSX-returning
components, and upper-case module constants from general naming comparisons.
The style gate does not compare named and default imports across unrelated
modules, because the imported module controls which form is valid. The
command-injection gate requires a recognized `child_process` call rather than
matching any `.exec()` method. Logic drift in Git projects compares changed
files with a fixed main merge base; a behavioral change is a review signal,
not proof of a defect. When the main reference is unavailable, that comparison
is unavailable rather than inferred from a moving local snapshot.

## CI Change Review

`rigour review --github-summary --diff changes.patch` prints a bounded GitHub
job summary. It ranks at most five located findings on added lines, gives a
rule-level reason and verification step, and counts findings outside the diff
or without a trustworthy line location separately. A zero-finding change
review does not certify the whole repository. `rigour review --json` retains
its existing fields and adds `ci_summary` with `schema_version: 1` for bots.
The summary never copies raw finding messages or source snippets; the full
JSON report can contain source-derived details and should remain a private CI
artifact. Deep analysis is opt-in and should use the same changed-line scope.
