# What Rigour checks, and how accurate it is

This page lists every check Rigour runs, what each one finds, and whether its findings block or are only notes. It then explains how Rigour decides what to show you, and how to measure its precision on your own code.

Every setting named here is listed with its default in [CONFIG_REFERENCE.md](CONFIG_REFERENCE.md).

## What blocks

One rule decides what blocks, in `packages/rigour-core/src/review/quiet.ts` (`mustFix`). The review verdict, the stop hook and the push gate all use it, so they never disagree about a finding. A rule that says how sure it is (the finding's `certainty`) decides first: only a `proven` finding blocks, and one marked `likely` or `possible` never does, whatever its check or severity. Otherwise a finding blocks when any of these is true:

- It comes from a **proven** check: one that traces the defect itself rather than guessing at it. These gate ids are proven: `semantic-bugs`, `hallucinated-imports`, `security-patterns`, `deep-analysis`, `diff-tests`, `unused-export`, `orphan-file`, `offset-paging`, `unbounded-window`, `duplicate-function`, `partial-fix`, `partial-wiring`, `migration-order`, `duplicate-null-filter`, `nullable-filtered-column`, `optional-always-supplied`, `write-only-property`, `typed-checks-unavailable`. `unused-export` and `orphan-file` block only when the team turns on their `block` setting (below); otherwise they are notes.
- Its severity is `critical`.
- Its severity is `high` and it was verified (the semantic rules and verified model findings set this), or it came from a security check.

Everything else is a **note**: listed with `rigour review --notes`, never deciding the verdict.

Three more things can block, outside that rule:

- **Branch checks**, before an agent stops (on a branch) and before a push: the branch no longer merges cleanly into main (`merge-conflict`), or a file still names a file the branch deleted (`stale-reference`).
- **The repository's own tools**, before a push only: formatter, linter, type check, related tests, the type-checked lint overlay and knip. See [The push-time toolchain](#the-push-time-toolchain).
- **A check that could not run.** If a proven check crashes, or the TypeScript program for the typed checks cannot be built, the review is `ERROR` (exit code 3), never a pass.

Two settings change the picture:

- `review.include_heuristics: true` makes every finding on a changed line count, notes included. With it on, notes block too.
- A finding must sit on a line the change touched to block. A finding about a whole file (no line) is shown as a note. A finding with no file at all is counted and not listed.

## Where each check runs

| Moment | What runs |
|:---|:---|
| After every edit (agent hook) | A fast per-file subset: protected paths, file size, hallucinated imports and promise safety (JS/TS), security patterns. See [After-edit checks](#after-edit-checks). |
| Before the agent says done (stop hook) | The review below, without the typed checks, plus the branch checks when on a branch. At most three stops. It also asks the agent, once per session for each, to check the change against the team's verified review lessons that apply to it (and the repository rules that name it, when `gates.deep.repo_rules` is on). |
| Before `git push` | The review with the typed checks, the branch checks, and the push-time toolchain. The reviewer too, when it is turned on ([REVIEWER.md](REVIEWER.md)). |
| `rigour review` | The review with the typed checks. No branch checks, no toolchain. Model review only when you pass `--deep`, `--pro`, `--max` or `-k` ([MODEL_REVIEW.md](MODEL_REVIEW.md)). |
| `rigour check` | The repository-wide gates and the `commands:` in rigour.yml. None of the review-only checks. |

### `rigour review` and `rigour check` compared

| | `rigour review` | `rigour check` |
|:---|:---|:---|
| What it looks at | The files a change touched (uncommitted work, `--base <ref>`, `--diff` or stdin) | The whole repository, or the paths you pass |
| Gates from the gate runner | Yes, scoped to the changed files | Yes |
| Review-only checks (unused exports, orphan files, query shapes, duplicate functions, partial fixes and wiring, optional parameters, quadratic copies, migration order) | Yes | No |
| Typed checks (redundancy) | Yes | No |
| `commands:` from rigour.yml | No (they run at push) | Yes; a command that exits non-zero is a finding |
| Which findings count | Only those on changed lines that the base did not already have | Every finding |
| What fails | Blocking findings only (the rule above) | Any finding of any severity |
| Dismissals and muting | Applied | Not applied |
| Exit codes | 0 pass, 1 fail, 3 a check could not run | 0 pass, 1 fail, 2 config error, 3 model review asked for but could not run |

Use `rigour review` for changes and pull requests ([CI.md](CI.md)). `rigour check` is a whole-repository audit; on an existing codebase it will report the code's history, not your change.

## The checks

"Default" says whether the check runs without configuration. "Blocks" applies the rule above to the severities each check produces.

### Correctness of the change

| Check | What it finds | Languages | Gate id | Default | Blocks |
|:---|:---|:---|:---|:---|:---|
| Semantic bugs | Type-aware rules that trace a value from where it enters to where it does harm, across files. See [Semantic rules](#semantic-rules). | JS/TS | `semantic-bugs` | On | Yes |
| Behaviour change | Runs changed exported functions before and after the change and reports inputs whose result changed. `rigour review --diff-tests` with `--max` or `-k`; vitest or jest packages. | JS/TS | `diff-tests` | On request | Yes |
| Partial fix | A change adds a broader condition, but the narrower one it replaces is still tested elsewhere in the same folder. | JS/TS, Svelte | `partial-fix` | On (`change_sweep`) | Yes |
| Partial wiring | A change adds a prop to some mounts of a component, and a sibling mount of the same kind (agreeing on a literal prop in at least three files) still lacks it. | Svelte, JSX/TSX | `partial-wiring` | On (`change_sweep`) | Yes |
| Logic drift | A comparison operator changed in a function (`>=` became `>`) compared with the main branch. Return and branch count changes are opt-in (`track_returns`, `track_branches`). | Languages with an adapter (see below) | `logic-drift` | On | Note |
| Async and error safety | Unhandled promises, unsafe `fetch`, async functions that never await, `.Result`/`.Wait()` deadlock risks, and similar. | JS/TS, Python, Go, Ruby, C# | `promise-safety` | On | Note |
| Side effects | Timers never cleared, spawned processes never reaped, infinite loops doing I/O, retries without a limit, file watchers that trigger themselves, leaked resources, unbounded recursion, restart loops. | JS/TS, Python, Go, Rust, C#, Java, Ruby | `side-effect-analysis` | On | Infinite I/O loops, self-triggering watchers and restart loops (critical) block; the rest are notes |
| Inconsistent error handling | The same error type handled in more than `max_strategies_per_type` ways across files. A handler that only hands the error to a helper (`return handle(e)`) is no way of its own. | Languages with an adapter | `inconsistent-error-handling` | On | Note |
| Model review | Findings from a model that read the changed code. Only when you ask for one. | Any | `deep-analysis` | On request | Yes |

"Languages with an adapter" means JS/TS, Python, Go, Ruby, C#, Java, Kotlin and Rust.

### The change against its goal

| Check | What it finds | Languages | Gate id | Default | Blocks |
|:---|:---|:---|:---|:---|:---|
| Goal scope | A changed file outside the `Scope` the pull request's description declares, or inside its `Out of scope`. Tests, snapshots, lockfiles, changelogs and release notes are exempt. See [The goal check](GOAL.md). | Any | `goal-scope` | Off (`review.goal`) | Yes |
| Goal done when | A `Done when` item in the description names a file or symbol the change never touches. | Any | `goal-done-when` | Off (`review.goal`) | A file blocks; a symbol is a note |

### Dead code and duplication

| Check | What it finds | Languages | Gate id | Default | Blocks |
|:---|:---|:---|:---|:---|:---|
| Unused export | An export on an added line that no other file imports from its module, or from a barrel that re-exports the module with `export * from` (a chain of them too). A test is not a consumer. Framework route and hook exports are skipped. | JS/TS, Svelte | `unused-export` | On | Note; `block: true` makes it block |
| Compiled lesson | A verified review lesson a person compiled into a check: a symbol it forbids, or one it requires a partner for within three lines, on a changed line. Only approved checks run ([REVIEWER.md](REVIEWER.md#lessons-compiled-into-checks)). | Any | `compiled-lesson` | On | Note; `block: true` makes it block |
| Orphaned file | A new code file that nothing imports or runs. Routes, hooks, tests, migrations and config files are skipped. A folder of new files that only import each other is reported as a whole. | JS/TS, Svelte | `orphan-file` | On | Note; `block: true` makes it block |
| Duplicate function | A changed function whose body is the same, line for line, as another function in the touched files (comments and layout ignored; at least 4 statements and 6 lines). | JS/TS, Svelte | `duplicate-function` | On | Yes |
| Optional member every host supplies | An optional property that every object providing it sets. | TypeScript | `optional-always-supplied` | On (`redundancy`) | Yes |
| Write-only property | A property the hosts set that nothing reads. It blocks only when the value is shown never to leave. Stored in a container (`map.set`, `push`, `add`, an index assignment), returned from an exported function nothing in the program calls, serialised (also inside another type, or as an object literal passed to `Response.json`), or put in a string, it is a hint naming where. A read through a same-shape type it was carried as counts as a read. | TypeScript | `write-only-property` | On (`redundancy`) | Yes |
| Optional only for tests | A parameter the change adds as optional that every non-test call passes. | JS/TS | `optional-for-tests` | On | Note |
| Near-duplicate across files | Functions in different files that are near-identical by structure or meaning, even with different names. | JS/TS, Python, Go, Rust | `duplication-drift` | On | Note |
| Reference to a deleted file | A file that still names a file the branch deleted. Stop and push only. | Code, docs, config, scripts | `stale-reference` | On | Yes (branch check) |

### Data and queries

| Check | What it finds | Languages | Gate id | Default | Blocks |
|:---|:---|:---|:---|:---|:---|
| Offset paging | `.range()` or `.offset()` inside a loop or a pager callback on an added line. Each page re-reads the rows before it, and rows inserted mid-sweep are skipped or read twice. | JS/TS (query-builder chains) | `offset-paging` | On (`query_patterns`) | Yes |
| Unbounded window | A lower bound on a time column taken from a window object, with no upper bound on the same column in the same query. A bare "since" query is not reported. | JS/TS | `unbounded-window` | On (`query_patterns`) | Yes |
| Redundant null filter | `.not(col, 'is', null)` in a chain that already ranges or equals on `col`. | TypeScript | `duplicate-null-filter` | On (`redundancy`) | Yes |
| Nullable type for a filtered column | The query filters a column non-null, but the row type still says `\| null`, so every guard on it is dead. | TypeScript | `nullable-filtered-column` | On (`redundancy`) | Yes |
| Dead null guard | A guard (`??`, `?.`, `== null`, `!x.col`, a truthiness test) on a column every query returning the row type filters non-null, while no code builds that row with the column missing or null. A string column's truthiness test is reported with the empty-string case named; number and boolean ones are not reported. | TypeScript | `dead-null-guard` | On (`redundancy`) | Note |
| Constant member | A property every production object of the type sets to the same literal, while code branches on it: the other branches never run outside tests. | TypeScript | `constant-member` | On (`redundancy`) | Note |
| Constant argument | A parameter every production call (two or more) passes the same literal, while the body branches on it. A function passed around as a value is never reported. | TypeScript | `constant-argument` | On (`redundancy`) | Note |
| Nullable type for a NOT NULL column | The row type of `.from('t')` says `\| null` for a column the migrations in `schema_migrations` make NOT NULL. | TypeScript | `nullable-not-null-column` | On (`redundancy`) | Note |
| Quadratic copy | An accumulator copied whole on every loop step (`acc = [...acc, item]`). | JS/TS | `quadratic-copy` | On (`change_sweep`) | Note |
| Migration out of order | A migration the change adds that sorts before the newest migration on the base. Only folders in `dirs` (default `**/supabase/migrations`). | SQL migrations | `migration-order` | Off | Yes, when enabled |
| Unindexed read | A supabase-js read whose table, as the repository's migrations define it, has no index that can serve it. Row-level policies and partial indexes are taken into account. | JS/TS, SQL migrations | `unindexed-reads` | Off | Note |

### Security and secrets

| Check | What it finds | Languages | Gate id | Default | Blocks |
|:---|:---|:---|:---|:---|:---|
| Security patterns | SQL injection, XSS, path traversal, hardcoded secrets, insecure randomness, command injection and more. Only findings at or above `block_on_severity` (default `high`) are reported. A call written in a string literal or a comment (`MSG = "subprocess.call(cmd, shell=True)"`) is not a call; patterns about a string's contents (secrets, keys, header values) still match inside strings. Code inside a string interpolation (`f"{…}"`, `${…}`) counts as string, and a string spanning lines is read as code past its first line. | JS/TS, Python; secret patterns also Java and Go | `security-patterns` | On | Yes |
| Frontend secret exposure | A server secret referenced from a file that ships to the browser (`process.env.X` / `import.meta.env.X` without a public prefix), or a live key literal in source. Only `critical` and `high` are reported by default. | JS/TS, Vue, Svelte | `frontend-secret-exposure` | On | Yes |
| Prototype pollution | A write through `__proto__`, `constructor` or `prototype` (likely); a read of one, or an `Object.assign({}, …)` merge (possible). Pollution needs a key an attacker controls, which the rule cannot trace. | JS/TS | `ast-analysis` (`SECURITY_PROTOTYPE_POLLUTION`, `…_MERGE`) | On | Note |
| Unsafe call | A dangerous execution sink found from the syntax tree. | Go, Java, Rust, C#, C++ | `ast-analysis` (`SME_SECURITY_SINK`) | On | Yes |
| Security-deprecated API | An API deprecated for security reasons (`new Buffer()`, weak hashes and similar), used in code: the same text in a string literal or a comment is not a use. A note by default (deprecated is not always vulnerable); with `block_security_deprecated: true` it is critical and blocks. Python and Go test files are skipped. | JS/TS, Python, Go, C#, Java | `deprecated-apis` | On | Note; `block_security_deprecated: true` makes it block |

### Mistakes coding agents make

| Check | What it finds | Languages | Gate id | Default | Blocks |
|:---|:---|:---|:---|:---|:---|
| Hallucinated import | An import of a package, file or module that does not exist in the project, its manifests or the standard library. A Rust file is checked against its own crate's Cargo.toml and its workspace; a Go file against go.mod, including the modules it requires. With no manifest found, an unresolved import is a note, not a block. | JS/TS, Python, Go, Ruby, C#, Rust, Java, Kotlin | `hallucinated-imports` | On | Yes |
| Phantom API | A call to a method that does not exist on a known standard-library module (`fs.readFileAsync`, `path.combine`). | JS/TS, Python, Go, C#, Java, Kotlin | `phantom-apis` | On | Note |
| Deprecated API | A removed or superseded API (not the security ones above). | JS/TS, Python, Go, C#, Java | `deprecated-apis` | On | Note |
| Context window artifacts | A long file whose quality falls from top to bottom: fewer comments, shorter names, sparser error handling. | Languages with an adapter | `context-window-artifacts` | On | Note |
| Context drift | A new variation of an existing environment-variable name, or naming and import styles that differ from the project's dominant style. | Most code files | `context-drift` | On | Note |
| Retry loop | The same operation has failed `max_retries` times in a row; tells the agent to stop and read the documentation. | Any | `retry_loop_breaker` | On | Counted in a review (no file); fails `rigour check` |
| Protected file changed | A modified file under `safety.protected_paths` (default `.github/**`, `docs/**`, `rigour.yml`). | Any | `file-guard` | On | Note |
| Dependency issues | A forbidden package, an unused dependency, a heavy package with a lighter alternative, two packages for one purpose. | package.json; forbidden packages also requirements.txt | `dependency-guardian` | On | Note |
| Deprecated dependency | A dependency whose installed version npm marks deprecated. Asks the registry; cached for a day; an unreachable registry means no findings. | package.json | `deprecated-dependencies` | Off | Note |
| Agent team, checkpoints | Multi-agent scope conflicts and quality decline over a long session. | Any | `agent-team`, `checkpoint` | Off | Note |

### Tests

| Check | What it finds | Languages | Gate id | Default | Blocks |
|:---|:---|:---|:---|:---|:---|
| Test quality | Empty tests, tautological assertions, tests that mock everything, async tests that never await or assert. A call to an assertion helper counts as an assertion: one the test imports named `expect…`, `assert…` or `should…`, or one defined in the test file or an in-repo module it imports whose body asserts (in JS/TS and Python, including a base-class method called on `self`). | JS/TS, Python, Go, Java, Kotlin | `test-quality` | On | Note |
| Coverage | A file below 50% line coverage (80% for complex files), read from an existing `lcov.info` or `coverage-final.json`. Silent when there is no report. | Any with a coverage report | `coverage-guard` (`DYNAMIC_COVERAGE_LOW`) | On | Note |

At push, the tests that import changed files also run; see the toolchain below.

### Structure and style

| Check | What it finds | Languages | Gate id | Default | Blocks |
|:---|:---|:---|:---|:---|:---|
| Complexity, size of classes and signatures | A function over `ast.complexity` (10), a class over `ast.max_methods` (10), a function over `ast.max_params` (5). Python needs a `python3` or `python` on the path. | JS/TS, Python; cognitive load for Go, Java, Rust, C#, C++ | `ast-analysis` (`AST_COMPLEXITY`, `AST_MAX_METHODS`, `AST_MAX_PARAMS`, `SME_COGNITIVE_LOAD`) | On | Note |
| Architecture boundary | An import that a `gates.architecture.boundaries` rule denies. | JS/TS | `ast-analysis` (`ARCH_BOUNDARY`) | On when rules exist | Note |
| Outdated syntax | `var`, `require()`, `arguments` and similar, per `staleness.rules`. | JS/TS | `ast-analysis` (`STALENESS_*`) | Off | Note |
| Style drift | A changed or new file whose naming or error-handling style deviates by more than 25% from its language's code committed on the main branch (outside Git, a baseline file built on the first full scan). A one-word lowercase name (`run`, `data`) or a dunder (`__init__`) counts as neither camelCase nor snake_case; a private name is read without its leading underscores (`_load_rows` is snake_case). | Languages with an adapter | `style-drift` | On | Note |
| File size | Files over `max_file_lines` (500). | Any | `file-size` | On | Note |
| Forbidden markers | `TODO` and `FIXME` comments (`forbid_todos`, `forbid_fixme`). | Code, shell, YAML, JSON | `content-check` | On | Note |
| Required files | Files in `required_files` that do not exist. | Any | `structure-check` | On | Note |
| Environment | A required tool missing or at the wrong version, a required environment variable missing. | Any | `environment-alignment` | On | Note |
| Merge conflict | The branch no longer merges cleanly into main. Stop and push only. | Any | `merge-conflict` | On | Yes (branch check) |

## Semantic rules

The `semantic-bugs` gate builds a TypeScript program and runs rules that name both ends of a defect: where a value enters and where it does harm. Anything the engine cannot resolve produces no finding. It uses no model and no network. Test files and `.d.ts` files are skipped.

Rules that run by default:

| Rule | Catches |
|:---|:---|
| `credential-redirect` | A custom credential header sent by a `fetch` that may follow redirects. `fetch` drops `Authorization` on a cross-origin redirect but keeps custom headers. |
| `in-memory-aggregation` | Every page of a paged read collected into an array that is then only counted or capped. |
| `degraded-response-cached` | A response cached with a positive `max-age` while its body can carry a failure fallback. |
| `vue/static-computed` | `computed(() => x)` where `x` was built once in setup, so it never updates. |
| `react/inline-html-object` | `dangerouslySetInnerHTML={{ __html }}` built inline in a React 19 component, which rewrites the element on every render. |
| `ts/internal-in-public-signature` | An exported function destructures an `@internal` property while `stripInternal` is set, so the published types do not check. |
| `deps/internal-symbol` | Reading a library's internal `Symbol.for(...)` with the type error silenced. |
| `deps/codegen-undeclared-import` | Generated code imports a package the generating package does not declare. |
| `vite/rollup-only-hook-field` | A plugin hook returns `syntheticNamedExports` in a package built for Rolldown-based Vite. |
| `dom/self-query-in-component` | A component scans the whole document to find its own element. |
| `exports/condition-parity` | A conditional entry (`index.browser.ts`, `index.react-server.ts`) exports fewer names than the default entry. |

Candidate rules run only when named in `gates.semantic_bugs.rules` or with `rigour scan-rules --rules <ids>`: `solid/jsx-and-conditional`, `paths/unnormalized-module-key`, `env/bare-browser-global`, `exports/forgotten-type`, `imports/barrel-cycle`.

```yaml
gates:
  semantic_bugs:
    enabled: true
    rules: [credential-redirect]   # optional; the default set when omitted
```

**Rules learned from your fixes.** `rigour learn <commit>` (or `--before <file> --after <file>`) turns a fix into a rule for the same bug. A candidate rule is kept only if it fires on the code before the fix, is silent after it, and fires on at most `--max-hits` (default 3) other places. Kept rules are saved in `.rigour/rules/`, reviewed and committed like code, and run by this gate as `learned/<id>`. Use `--dry-run` to see what would be learned.

**Rules learned from agent fixes.** When a review reports a finding and a later review of the same file no longer does, the file before and after is kept in `.rigour/agent-fixes/`. `rigour learn --agent-fixes` turns those into rules with the same validation.

## Typed checks

The checks with gate ids `duplicate-null-filter`, `nullable-filtered-column`, `nullable-not-null-column`, `optional-always-supplied`, `write-only-property`, `dead-null-guard`, `constant-member` and `constant-argument` use the project's own TypeScript program (its `tsconfig.json` and installed `typescript`). Building it takes seconds, so they run at push and in `rigour review`, not at every stop. They only look at lines the change touched or members it declared.

- If the project is TypeScript and the program cannot be built (dependencies not installed, generated config missing), the review reports `typed-checks-unavailable` and blocks. A checkout that cannot prove the change is never a pass.
- `wire_contracts` lists files whose types another service reads, so their members are never reported as write-only.
- An optional member every host supplies is only a hint when values of the type are also read back from JSON as that type (`JSON.parse`, `readJson`, a response's `.json()`, through an `as`, an annotated variable, a type argument or the declared return type). Data written before the member existed lacks it, so it stays optional until that data is migrated.
- `schema_migrations` lists folders of SQL migrations (default `supabase/migrations`; relative, absolute or `~/`; another repository is fine, read only). Rigour replays them to learn which columns are NOT NULL. Missing folders are skipped.
- A function that scans a collection and is called once per item of another is a hint for the reviewer. Hints are listed with `rigour review --notes`.

```yaml
gates:
  redundancy:
    wire_contracts: ["src/lib/contracts/**"]
    schema_migrations: ["../database/supabase/migrations"]
  unused_exports:
    allow: [register]              # export names a tool loads by name
    block: true                    # this team's reviewers block on dead exports
  orphan_files:
    allow: ["scripts/one-off/**"]  # files a tool loads by path
```

**Dead code is a note unless your team blocks on it.** Across real approved pull requests from many
teams, the exports reviewers let through were mostly test seams and types another export's signature
needs. Blocking on them by default stopped approved code. A team whose reviewers do block on dead exports
or files sets `block: true`, and from then on the review, the stop hook and the push gate refuse them.

Turn any review-only check off with `enabled: false` under its setting: `unused_exports`, `orphan_files`, `query_patterns`, `duplicate_functions`, `optional_params`, `change_sweep`, `redundancy`. `migration_order` and `unindexed_reads` are off until you set `enabled: true`.

## The push-time toolchain

Before a push, Rigour runs the repository's own tools on what the branch changed. Their failures block the push.

| Tool | What runs | When it is skipped |
|:---|:---|:---|
| `format` | `prettier --check` on changed files | prettier not installed |
| `lint` | `eslint --max-warnings=0` on changed code files | eslint not installed |
| `overlay` | eslint with type-checked `typescript-eslint` rules the repository does not enable (`no-unnecessary-condition`, `no-floating-promises`, `no-misused-promises` and others), layered on the repository's own `eslint.config.*`. Blocks on changed lines only; the rest is counted. | eslint or `typescript-eslint` not available |
| `typecheck` | The `typecheck` or `check` script in package.json; else `svelte-kit sync` and svelte-check; else `tsc --noEmit` with a tsconfig.json | none of these present |
| `test` | `vitest related --run` on changed code files; a test file that fails in the parallel run is run again alone | vitest not installed |
| `knip` | `knip --production`, reporting only the changed files | knip not installed |

Nothing is downloaded: only tools in the project's `node_modules/.bin` run. A tool the project never declared is skipped and the output says so. A tool declared in package.json but not installed fails, since a checkout without its dependencies cannot prove anything.

To run your own command instead of the detected one, set it under `commands:` in rigour.yml. Rigour runs it as written, on the whole project, and its failure blocks the push. The keys are `format`, `lint`, `typecheck` and `test`.

```yaml
commands:
  typecheck: "npm run typecheck"
  test: "npm test"
```

`rigour check` also runs these commands, and a command that exits non-zero is a finding there. `rigour review` does not run them.

## After-edit checks

The edit hook runs a fast subset on each file an agent writes, with a default time limit of 5 seconds:

- protected paths (`safety.protected_paths`) and agent memory and skill paths (`governance`);
- file size (`max_file_lines`);
- hallucinated imports and promise safety, for JS/TS files;
- security patterns, for every language.

Files matching `ignore` in rigour.yml are skipped. If the time limit runs out before every file is checked, that is reported as a failure. Setting the hooks up is covered in [DEVELOPMENT.md](DEVELOPMENT.md).

## How Rigour decides what to show

A review reports what the change introduced, not what the code already had.

1. **Changed files only.** The gates run on the files the diff touches. Generated files (names such as `*.gen.ts`, `generated/`, lockfiles, or a `@generated` / `DO NOT EDIT` marker in the first kilobyte) are left out.
2. **Changed lines only.** A finding is listed when its line is one the change added or modified, or when the change deleted lines inside it. A model finding on an unchanged line inside a changed function is placed on the nearest changed line. A check that lists a file's violations as one finding (hallucinated imports, deprecated APIs, phantom APIs, async safety, test quality) is listed when any of them is on a changed line, placed on the first such line. Other findings in a changed file are counted.
3. **Pre-existing findings are counted, not listed.** Rigour runs the same gates on the repository as it was at the base commit (a read-only copy made with `git archive`). A finding the base already had is not reported, even if its numbers moved (a function at complexity 105 that reaches 109 is the same problem). Findings in files the change adds always count as new. Model findings are never compared this way; the model only reviews the change. The output says how many were left out.
4. **Proven or note.** The rule in [What blocks](#what-blocks) splits what is left into blocking findings and notes.

Two settings change this:

| Setting | Default | Effect |
|:---|:---|:---|
| `review.show_preexisting` | `false` | `true` skips step 3 and reports findings the base already had. |
| `review.include_heuristics` | `false` | `true` makes every finding on a changed line block, notes included. |

`rigour review` lists the first five blocking findings; `--all` lists every one, and `--notes` lists the notes and hints.

## How precision is kept honest

Rigour does not publish an accuracy number for your code. It gives you the tools to measure it, and it quiets checks your team keeps rejecting.

### Dismiss what is wrong

When a finding is not a bug, dismiss it by the key printed with it:

```bash
rigour dismiss 3f9a1c0b7d2e4a61 --reason "small lookup table, no index needed"
```

The key is built from the gate, the file and the message, never the line, so the dismissal survives edits. Dismissals are stored in `.rigour/dismissed.json`; commit it so the finding stays quiet for everyone. Only people dismiss: agents are not offered this command. With `rigour review --independent --base <ref>`, dismissals are read from the base, so a change cannot dismiss its own findings.

### Quiet the checks your team rejects

Rigour counts, per check, the findings that were later fixed and the findings that were dismissed. `rigour precision` shows each check's precision in this repository: (fixed + 1) / (fixed + dismissed + 2).

```bash
rigour precision
```

A note-level check with at least 5 outcomes and a precision below 0.25 is muted: its findings are counted, not listed. Proven checks are never muted. The counts live in `.rigour/check-outcomes.json`.

### Score the review against your own pull requests

`rigour backtest` runs the review on commits people reviewed (listed in `.rigour/backtest.json`), with each human review hidden, and scores Rigour's findings against the points the reviewer made. A point counts as caught only when a blocking finding matches it; a match in a note counts as missed. A blocking finding on code the reviewer called good counts as a false block. Use it before changing a rule or turning on a check. See [BACKTEST.md](BACKTEST.md).

### The accuracy suite

Rigour's own repository has a regression suite for the checks that block. Contributors run it with:

```bash
pnpm accuracy:check
```

It runs the tests for hallucinated imports (including SvelteKit), phantom APIs, security patterns (including the OWASP set), test quality, deprecated APIs, side-effect analysis, frontend secret exposure, the semantic gate, rule learning and the semantic benchmark. The semantic benchmark requires a case for every semantic rule plus negative cases, and fails if any case is missed or any false positive appears. See [../CONTRIBUTING.md](../CONTRIBUTING.md).

### Narrow before you disable

When a check is noisy on part of your code, exclude that part rather than the check:

```yaml
ignore:
  - "legacy/**"
gates:
  hallucinated_imports:
    ignore_patterns: ["^@generated/"]
  duplication_drift:
    similarity_threshold: 0.85
```
