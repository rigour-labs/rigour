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

### Only what the change introduced

A review reports what the change introduced, not what the code it touched
already had. The same rules run on the repository as it was at the base (the
merge-base for `--base`, `HEAD` for uncommitted work), extracted read-only into
a temporary folder, and a finding the base already had is counted as
`preexisting` instead of reported, even when the change moved its numbers (a
function at complexity 105 that reaches 109 is the same old problem). Findings
in files the change adds always count as introduced; model findings are never
compared. Set `review.show_preexisting: true` in `rigour.yml` to list them all.
Rule scans read files in a fixed order, so the same code gives the same report.

### Dead code a change adds

Two deterministic checks run on what a change adds, and block a review, the
stop hook and the push gate: an **unused export** (an export or re-export on an
added line that no other file uses; a file uses it only when it names it and
imports, re-exports, dynamically imports or mocks its module, so a same-named
word elsewhere is not a use; framework route exports are skipped) and an
**orphaned file** (a new code file nothing outside the change's new files
imports or runs; paths are resolved, so a common basename elsewhere never keeps
a file alive, and a group of new files that only import each other is reported
together). Rigour's own reports never count as a use.

Four more read the syntax tree of what a change adds. Before any of them was
allowed to block, each ran over recent merged pull requests in several real
repositories and every finding was judged; a check that raised a false alarm
was fixed or kept advisory:

| Check | What it reports | Blocks |
| --- | --- | --- |
| `offset-paging` | `.range()` / `.offset()` paging inside a loop, or in a callback handed to a pager | yes |
| `unbounded-window` | a time column read from a window's start (`window.from`) with no upper bound; a bare "since" is not reported | yes |
| `duplicate-function` | a changed function (TypeScript or a Svelte script) whose body copies another in the files the change touched | yes |
| `optional-for-tests` | an optional parameter or option that every production call passes and only tests omit | advisory: most hits are deliberate test seams |
| `partial-fix` | a new named condition widens one (`a.length > 0 \|\| count > 0`) while the narrower form (`count > 0`) is still tested on its own in the same folder | yes |
| `partial-wiring` | a callback the change adds to most same-kind mounts of the project's own component (`mode="quiz"`, in several files) but not one | yes |
| `quadratic-copy` | an accumulator spread into a new copy on every step of a loop or reduce | advisory: true, but usually on small collections |

Two more run on the branch as a whole before an agent stops or pushes: a
**merge conflict** with main (`git merge-tree`, without touching the working
tree) and a **reference to a deleted file** (a file that still names a path
the branch deleted, matched as the whole path).
