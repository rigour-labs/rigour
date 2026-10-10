# The fix packet and the report

Rigour writes two JSON files when it checks a repository:

- `rigour-report.json`, the report: everything the check found, the status of each gate, and the scores.
- `rigour-fix-packet.json`, the fix packet: the same findings rewritten as a work order for whoever fixes them. Each finding carries its locations and steps, and the packet adds the commands to run afterwards and the limits to respect while fixing.

Use the report when a script needs to know what happened. Use the fix packet when you hand the work to a coding agent or a script that edits code. The packet is generated from the report, so the two always describe the same run.

A third shape, `rigour review --json`, goes to standard output and covers only the lines a change touches. It is described below in [The `rigour review --json` output](#the-rigour-review---json-output).

## Which commands write them

| Command | `rigour-report.json` | `rigour-fix-packet.json` |
|:---|:---|:---|
| `rigour check` | Every run, including `--json`, `--ci` and a run answered from the cache | Only when the status is `FAIL`, and not on a cache hit |
| `rigour scan` | Every run, including `--json` and `--ci` | Only when the status is `FAIL` |
| `rigour run -- <agent command>` | After each cycle | After each cycle that ends in `FAIL` |
| `rigour review` | Never | Never |
| MCP `rigour_get_fix_packet` | Never | Never (it returns text pages; see [below](#the-mcp-tool-rigour_get_fix_packet)) |

Both files go in the directory the command runs in. The report's name comes from `output.report_path` in `rigour.yml` (default `rigour-report.json`). The fix packet's name is fixed: `rigour-fix-packet.json`.

Two things to know before a script reads these files:

- Rigour never deletes an old fix packet. After a run that passes, a `rigour-fix-packet.json` from an earlier failing run is still on disk. Read `status` in the report first, and treat the packet as current only when the report says `FAIL`.
- A plain `rigour check` (no file arguments, no model review) caches its result and reuses it when neither the files nor `rigour.yml` have changed. A cache hit rewrites the report but does not regenerate the fix packet. `rigour check --no-cache` forces a full run.

`rigour setup --team`, in a repository that has no `rigour.yml` yet, adds both file names to `.gitignore`.

`rigour explain` and `rigour export-audit` read the report from `output.report_path`. The MCP server reads it to show the last score on its dashboard.

### Exit codes

`rigour check` exits `0` on `PASS` and `1` on `FAIL`. It exits `3` when model review was requested (`--deep`, `--pro`, `--max` or `-k`) but did not run, so CI cannot mistake that run for a clean or ordinary failing one. A missing or invalid `rigour.yml` exits `2`. With `--json`, a missing config prints `{"error": "CONFIG_ERROR", "message": "..."}`.

`rigour scan` exits `0` on `PASS` and `1` on `FAIL`.

`rigour run` exits `0` when a cycle passes. It exits `1` when it reaches `--max-cycles` (default 3) without a pass, when `--fail-fast` is set and a cycle fails, or when the agent changed more files in one cycle than `gates.safety.max_files_changed_per_cycle` (default 10).

## The fix packet: `rigour-fix-packet.json`

The schema is `FixPacketV2Schema` in `packages/rigour-core/src/types/fix-packet.ts`, exported from `@rigour-labs/core` together with the `FixPacketV2` type. Despite the name, the packet's `version` is `3`. The packet is built by `FixPacketService.generate(report, config)` in `packages/rigour-core/src/services/fix-packet-service.ts` and validated against the schema before it is written.

### Top level

| Field | Type | Required | Meaning |
|:---|:---|:---|:---|
| `version` | `3` | Required | The packet format. Always the number `3`. |
| `goal` | string | Required (schema default) | One sentence for the agent. The generator writes `"Achieve PASS state by resolving all listed engineering violations."` |
| `failed_gates` | string[] | Required | The `id` of every finding, without duplicates, in the order the report lists them. |
| `violations` | object[] | Required | One entry per finding in the report, sorted by severity: `critical`, `high`, `medium`, `low`, `info`. |
| `verification` | object | Optional in the schema; the generator always writes it | What to run after fixing. |
| `constraints` | object | Required (schema default `{}`) | Limits the fixer should respect. |

### `violations[]`

| Field | Type | Required | Meaning |
|:---|:---|:---|:---|
| `id` | string | Required | The finding's `id` from the report: the gate that raised it (`file-size`, `hallucinated-imports`), or the command key (`lint`, `test`) when one of `rigour.yml`'s `commands` failed. |
| `gate` | string | Required | The same value as `id`. Kept for older readers. |
| `severity` | `info` \| `low` \| `medium` \| `high` \| `critical` | Required (schema default `medium`) | The finding's severity; `medium` when the report gave none. |
| `category` | string | Optional | The finding's provenance from the report: `ai-drift`, `traditional`, `security`, `governance` or `deep-analysis`. It is not the report's `category` field. |
| `title` | string | Required | Short title of the finding. |
| `details` | string | Required | What is wrong. For a failed command, its stderr (or stdout). |
| `files` | string[] | Optional | Files as the gate reported them. Some gates append a note, for example `src/report.ts (612 lines)`. |
| `locations` | object[] | Optional | One entry per file in `files`, with the note removed. See below. |
| `hint` | string | Optional | The gate's suggested fix. |
| `instructions` | string[] | Optional | Steps for the fixer: the `hint` first, then one fixed step for these gates: `file-size`, `hallucinated-imports`, `phantom-apis`, `forbid-todos`, `security-patterns`, `promise-safety`, `deprecated-apis`, `duplication-drift`, `inconsistent-error-handling`. The generator always writes the array, empty when there is nothing to say. |
| `metrics` | object | Optional | Free-form numbers about the finding. The schema allows it; no current check fills it. |

### `violations[].locations[]`

| Field | Type | Required | Meaning |
|:---|:---|:---|:---|
| `file` | string | Required | The file path, with any trailing note in parentheses removed. |
| `line` | number | Optional | First line. Set only when the finding names exactly one file and has a line. |
| `endLine` | number | Optional | Last line, under the same condition. |

### `verification`

| Field | Type | Required | Meaning |
|:---|:---|:---|:---|
| `commands` | `{cmd, purpose}[]` | Required | The commands from `rigour.yml`'s `commands` section that are set, in this order: `typecheck`, `lint`, `test`, `format`. The last entry is always `{"cmd": "rigour_check", "purpose": "Re-run all quality gates to confirm PASS"}`. |
| `commands[].cmd` | string | Required | The command to run. `rigour_check` is the MCP tool's name; from a shell, run `rigour check`. |
| `commands[].purpose` | string | Required | Why to run it. |
| `gate_command` | string | Required (schema default `rigour_check`) | The Rigour tool to re-run. Always `rigour_check`. |

### `constraints`

The packet states these limits. It does not enforce them: the agent or script that applies the fixes has to. Elsewhere, `rigour run` stops when an agent changes too many files in one cycle, and Rigour's `file-guard` gate and edit hook act on `protected_paths`.

| Field | Type | Required | Meaning |
|:---|:---|:---|:---|
| `protected_paths` | string[] | Optional | `gates.safety.protected_paths` from `rigour.yml`. Default `[".github/**", "docs/**", "rigour.yml"]`. |
| `do_not_touch` | string[] | Optional | The same list as `protected_paths`. |
| `allowed_scope` | string[] | Optional | Every file named by a violation, without duplicates and with notes removed. Absent when no violation names a file. |
| `max_files_changed` | number | Optional | `gates.safety.max_files_changed_per_cycle`. Default `10`. |
| `no_new_deps` | boolean | Optional (schema default `true`) | The generator always writes `true`: fix without adding dependencies. |
| `allowed_dependencies` | string[] | Optional | In the schema; the generator never writes it. |
| `paradigm` | string | Optional | `paradigm` from `rigour.yml`, when set. |

### What the packet covers

The packet is built from the whole report, so it holds everything `rigour check` or `rigour scan` found in the files it scanned: findings the change did not introduce, and heuristic findings that [`rigour review`](CI.md) would only list as notes, are in it too. If you want only what a change introduced, use `rigour review --json` instead.

Some report fields do not reach the packet: `confidence`, `source`, `verified`, `anchorLine` and the report's own `category`. Read the report when a script needs them.

### Example

This packet comes from a `rigour.yml` that sets `commands.lint: npm run lint` and `commands.test: npm test`, keeps the default safety settings, and has one file over the `file-size` limit (500 lines by default). The lint and test commands passed.

```json
{
  "version": 3,
  "goal": "Achieve PASS state by resolving all listed engineering violations.",
  "failed_gates": ["file-size"],
  "violations": [
    {
      "id": "file-size",
      "gate": "file-size",
      "severity": "low",
      "category": "traditional",
      "title": "File Size Limit",
      "details": "The following files exceed the maximum limit of 500 lines:",
      "files": ["src/report.ts (612 lines)"],
      "locations": [{ "file": "src/report.ts" }],
      "hint": "Break these files into smaller, more modular components to improve maintainability (SOLID - Single Responsibility Principle).",
      "instructions": [
        "Break these files into smaller, more modular components to improve maintainability (SOLID - Single Responsibility Principle).",
        "Break the file into smaller modules following Single Responsibility Principle"
      ]
    }
  ],
  "verification": {
    "commands": [
      { "cmd": "npm run lint", "purpose": "Ensure no lint violations" },
      { "cmd": "npm test", "purpose": "Ensure all tests pass" },
      { "cmd": "rigour_check", "purpose": "Re-run all quality gates to confirm PASS" }
    ],
    "gate_command": "rigour_check"
  },
  "constraints": {
    "protected_paths": [".github/**", "docs/**", "rigour.yml"],
    "do_not_touch": [".github/**", "docs/**", "rigour.yml"],
    "allowed_scope": ["src/report.ts"],
    "max_files_changed": 10,
    "no_new_deps": true
  }
}
```

### Using it

With a coding agent, the loop is: run `rigour check`, give the agent `rigour-fix-packet.json`, let it fix the violations in order, run the `verification.commands`, and repeat until the report says `PASS`. `rigour run` automates the loop around an agent command:

```bash
rigour run -c 5 -- <your agent command>
```

`rigour run` runs the agent command unchanged in every cycle; it does not pass the packet to the agent. The agent has to be told to read `rigour-fix-packet.json`.

Agents connected over MCP use [`rigour_get_fix_packet`](#the-mcp-tool-rigour_get_fix_packet) instead of the file.

## The report: `rigour-report.json`

The schema is `ReportSchema` in `packages/rigour-core/src/types/index.ts`, exported from `@rigour-labs/core` with the `Report` type. `rigour check --json` prints the same object to standard output. `rigour scan --json` prints it inside a wrapper: `{"mode", "preset", "paradigm", "stack", "report"}`.

### Top level

| Field | Type | Required | Meaning |
|:---|:---|:---|:---|
| `status` | `PASS` \| `FAIL` \| `SKIP` \| `ERROR` | Required | `FAIL` when there is at least one finding, else `PASS`. The check writes only these two values here. |
| `summary` | object: gate id to status | Required | One entry per gate that ran. A gate is `PASS` or `FAIL`; `SKIP` when it could not check (its reason is in `skips`, for example style-drift and logic-drift with no main branch to compare with); `ERROR` when it crashed (the crash is also listed as a finding, titled `Gate Error: ...`, so the run is `FAIL`). Each key of `rigour.yml`'s `commands` section appears too: `SKIP` when the command is empty, else `PASS` or `FAIL`. Model review, when it ran, is under `deep-analysis`. |
| `skips` | object: gate id to reason | Optional | Why each `SKIP` gate could not check. Absent when none skipped. |
| `failures` | object[] | Required | Every finding, with duplicates of the same rule on the same file and line removed. |
| `stats` | object | Required | Timing, scores and counts. |

### `failures[]`

| Field | Type | Required | Meaning |
|:---|:---|:---|:---|
| `id` | string | Required | The gate, or the `commands` key, that raised it. |
| `title` | string | Required | Short title. |
| `details` | string | Required | What is wrong. |
| `severity` | `critical` \| `high` \| `medium` \| `low` \| `info` | Optional | Severity. Readers treat a missing value as `medium`. |
| `provenance` | `ai-drift` \| `traditional` \| `security` \| `governance` \| `deep-analysis` | Optional | What kind of check raised it. Readers treat a missing value as `traditional`. |
| `files` | string[] | Optional | Files involved, as the gate reported them. |
| `line` | number | Optional | First line. |
| `endLine` | number | Optional | Last line. |
| `anchorLine` | number | Optional | For a finding about a changed function that sits off the changed lines: the changed line to post it on. |
| `hint` | string | Optional | Suggested fix. |
| `confidence` | number, 0 to 1 | Optional | The model's confidence, for model findings. |
| `source` | `ast` \| `llm` \| `hybrid` | Optional | Where the finding came from. |
| `category` | string | Optional | A finer label from model review, for example `srp_violation` or `god_function`. |
| `verified` | boolean | Optional | A model finding that a syntax-tree check confirmed. |

### `stats`

| Field | Type | Required | Meaning |
|:---|:---|:---|:---|
| `duration_ms` | number | Required | How long the run took. |
| `score` | number | Optional; the check always writes it | 0 to 100. Each finding deducts by severity (critical 20, high 10, medium 5, low 2, info 0), each gate's deduction is capped, and the total deduction is capped at 90 unless a finding is critical. |
| `ai_health_score` | number | Optional; always written | The same calculation over `ai-drift` findings only. |
| `structural_score` | number | Optional; always written | The same calculation over `traditional` findings only. |
| `code_quality_score` | number | Optional | The same calculation over `deep-analysis` findings. Written only when model review was requested. |
| `severity_breakdown` | object: severity to count | Optional; always written | Findings per severity. Severities with no findings are absent. |
| `provenance_breakdown` | object | Optional; always written | Findings per provenance, with all five keys: `ai-drift`, `traditional`, `security`, `governance`, `deep-analysis`. |
| `deep` | object | Optional | Model review statistics, present only when it was requested. See below. |

Security and governance findings lower `score` but neither sub-score.

### `stats.deep`

Every field except `enabled` is optional.

| Field | Type | Meaning |
|:---|:---|:---|
| `enabled` | boolean | Model review was requested. |
| `status` | `ok` \| `partial` \| `error` | `ok`: every model call ran. `partial`: some failed. `error`: model review did not run, and `rigour check` exits `3`. |
| `mode` | `facts` \| `code` | What the model was given. |
| `tier` | `deep` \| `lite` \| `legacy` \| `max` \| `cloud` | Which model tier ran. |
| `model` | string | The model name. |
| `model_fallback` | boolean | A different model than the one asked for was used. |
| `total_ms` | number | Time spent in model review. |
| `files_analyzed` | number | Files the model reviewed. |
| `chunks_total`, `chunks_failed` | number | Pieces of code sent to the model, and how many failed. |
| `error` | string | Why model review did not run. |
| `findings_proposed` | number | Findings the model proposed before its self-check (code mode). |
| `findings_withdrawn` | number | Findings the self-check withdrew. |
| `findings_rejected` | object: reason to count | Findings the grounding check dropped, by reason. |
| `files_skipped` | number | Files left unreviewed because the run budget (`gates.deep.budget_ms`) ran out. |
| `tool_calls` | number | Repository lookups the model made. |
| `router` | `{functions, routed, files_skipped, already_reviewed}` | Cloud review: changed functions ranked, how many went to the model, files left to the rules, functions already reviewed. |
| `input_tokens`, `output_tokens` | number | Tokens used. |
| `cost_usd` | number | Cost the provider reported, else tokens times list price. Absent for a model with no known price. |
| `findings_count` | number | Model findings. |
| `findings_verified` | number | Model findings a syntax-tree check confirmed. |

## The `rigour review --json` output

`rigour review` reviews a change, not the whole repository: uncommitted work by default, a branch with `--base <ref>`, or a diff from `--diff <path>` or standard input. With `--json` it prints one object to standard output and writes neither file. The object is built in `writeJson` in `packages/rigour-cli/src/commands/review.ts`. The MCP tool `rigour_review` uses the same finding shape.

```bash
rigour review --base origin/main --json > review.json
```

### Top level

| Field | Type | Present | Meaning |
|:---|:---|:---|:---|
| `status` | `PASS` \| `FAIL` \| `ERROR` | Always | `FAIL` when `failures` is not empty. `ERROR` when model review was requested and did not run, or when a gate that proves defects crashed. |
| `checked` | object | Always | What was checked, so a verdict can be reproduced and proved later. See below. |
| `score` | number | Always | The underlying report's `score`; `100` when the change touched no file. |
| `ai_health_score`, `structural_score` | number | When files were checked | From the underlying report. |
| `total_failures` | number | Always | Findings on the changed files, after pre-existing ones are removed and before filtering to the changed lines. |
| `filtered_failures` | number | Always | Length of `failures`. |
| `unlocated_failures` | number | Always | Findings that name no file, so they cannot be placed in the change. |
| `ci_summary` | object | Always | A bounded summary for CI. See below. |
| `deep` | object | When model review was requested | The report's `stats.deep`. |
| `failures` | finding[] | Always | Findings on the changed lines that must be fixed. These decide the status. |
| `file_findings` | finding[] | Always | Findings about a changed file as a whole (no line). |
| `context_findings` | finding[] | Always | Model findings elsewhere in a changed file. Shown, never blocking. |
| `advisory` | finding[] | Always | Heuristic findings on changed lines. They never decide the status. |
| `muted` | number | Always | Advisory findings from checks this repository keeps dismissing: counted, not listed. |
| `dismissed` | number | Always | Findings a person dismissed with `rigour dismiss <key>`. |
| `preexisting` | number | Always | Findings the base already had: counted, not listed. |
| `control_files_changed` | string[] | Always | `rigour.yml` or `.rigour/` files the change edits. They steer the review, so they are called out. |
| `hints` | string[] | Always | Candidates for the reviewer to confirm, from the typed checks. |
| `gate_errors` | string[] | Always | Gates that crashed instead of running. |
| `typed_error` | string | When the typed checks could not run | Why. |
| `receipt` | object | When the change's diff can be read and the receipt built | The changed functions: how many were reviewed by agents, changed after review, low risk, and which risky ones were not reviewed. |
| `reviewer` | object | With `--reviewer` | The reviewer's verdict. Its `outcome` is `passed`, `findings`, `unavailable` or `skipped`, and `blocks` is `true` for `findings` and `unavailable`. See [REVIEWER.md](REVIEWER.md). |

Which findings land in `failures` and which in `advisory` is decided by the rules in [CHECKS.md](CHECKS.md).

### `checked`

The same Rigour version, settings and commits give the same checks, so these fields are enough to reproduce
a verdict, or to compare a review on a laptop with the one CI ran.

| Field | Type | Meaning |
|:---|:---|:---|
| `rigour_version` | string | The CLI version that reviewed. |
| `base` | string \| null | The ref the change was compared with (`--base`), or `null` for uncommitted work against `HEAD`. |
| `base_sha` | string \| null | The commit the comparison started from: the merge base with `base`, or `HEAD`. |
| `head_sha` | string \| null | `HEAD` when the review ran. |
| `uncommitted` | boolean | Tracked files differed from `HEAD`, so the review covered work that is not committed. |
| `config` | string | The settings read: a path such as `rigour.yml`, `rigour.yml at <commit>` for an independent review, or `defaults` when there is none. |
| `checks` | object | Every check the run reached, by id: `PASS`, `FAIL`, `SKIP` (switched off, or could not check: the report's `skips` says why) or `ERROR` (could not run). The review's own checks (`unused-exports`, `migration-order` and the rest) are listed beside the gates. A check whose findings were all already in the base, or only on lines the change did not touch, reads `PASS`: the change gave it nothing. |
| `preexisting` | object | By check, how many findings the base already had (left out of the verdict, and out of `checks`): `{ "ast-analysis": 2 }` beside `"ast-analysis": "PASS"` reads "passed, 2 pre-existing". Empty with `review.show_preexisting: true`, or when nothing was compared. |
| `outsideChange` | object | By check, how many findings sat only on lines the change did not touch (left out of the verdict, and out of `checks`), counted after `preexisting`. |

### A finding in `rigour review --json`

This shape is not the report's `failures[]` shape. It is built by `toReviewFinding` in `packages/rigour-core/src/review/review.ts`.

| Field | Type | Present | Meaning |
|:---|:---|:---|:---|
| `id` | string | Always | The gate that raised it. |
| `gate` | string | Always | The finding's title (the report's `title`, not the gate id). |
| `severity` | string | Always | Severity; `medium` when none was given. A finding that does not block is shown at most `high` when it is a security finding and at most `medium` otherwise: a heuristic's "high" is a guess at intent, not an impact Rigour stands behind. |
| `provenance` | string | Always | Provenance; `traditional` when none was given. |
| `message` | string | Always | The report's `details`. |
| `file` | string | Always | The first file; empty when there is none. |
| `line` | number or `null` | Always | The line, or `null`. |
| `anchor_line` | number | When set | For a finding inside a changed function but off the changed lines: the changed line to post it on. |
| `key` | string | Always | The same across runs for the same finding. `rigour dismiss <key>` silences it. |
| `certainty` | string | When set | How sure the rule that found it is: `proven` (it traced the defect, or states a fact) blocks on a changed line; `likely` is shown, never blocking; `possible` is a hint. When it is absent, the check's own rule decides ([CHECKS.md](CHECKS.md)). |
| `suggestion` | string | When the finding has a hint | The report's `hint`. |

### `ci_summary`

A summary sized for a CI log or a job summary, built from `failures`. `rigour review --github-summary` renders the same data as Markdown.

| Field | Type | Meaning |
|:---|:---|:---|
| `schema_version` | `1` | The summary's format. |
| `scope` | `"changed_lines"` | Always this value. |
| `changed_files` | number | Files the change touches. |
| `changed_lines` | number | Added or changed lines. |
| `findings_count` | number | Findings in `failures`. |
| `excluded_outside_changed_lines` | number | `total_failures` minus `findings_count`, `unlocated_omitted`, and the file findings (never below 0). Advisory findings are counted here. |
| `unlocated_omitted` | number | Findings with no file plus `file_findings`. |
| `severity` | `{critical, high, medium, low}` | Counts. An `info` finding is counted as `medium`. |
| `findings` | object[] | The first five findings, by severity, then file, line and rule. Each has `rule`, `severity`, `file`, `line` (1 when unknown), `reason` and `next_step`. |
| `truncated` | number | Findings left out of `findings`. |

### Exit codes and errors

`rigour review` exits `0` on `PASS`, `1` on `FAIL` and `3` on `ERROR`. With `--reviewer`, a blocking reviewer verdict makes the exit code at least `1`. A configuration or input error exits `2`, and an internal error exits `3`. With `--json`, an error prints one of:

```json
{ "error": "CONFIG_ERROR", "details": [ ... ] }
{ "error": "INPUT_ERROR", "message": "..." }
{ "error": "INTERNAL_ERROR", "message": "..." }
```

`rigour review --status --json` prints something else: what the background reviewer has done for the current branch. See [REVIEWER.md](REVIEWER.md).

## The MCP tool `rigour_get_fix_packet`

Agents connected to Rigour's MCP server get the fix packet through `rigour_get_fix_packet`. It is in the default tool set. See [AGENTS.md](AGENTS.md) for connecting an agent.

| Argument | Type | Required | Meaning |
|:---|:---|:---|:---|
| `cwd` | string | Required | The repository. |
| `offset` | integer, 0 or more | Optional | First violation to return. Default `0`. |
| `limit` | integer, 1 to 10 | Optional | Violations per page. Default `5`. |

Each call reviews **the agent's change** by the rule the stop hook and the push gate hold it to: the branch against main,
else uncommitted work, with the same certainty rule, changed-line filter and severity cap as `rigour review`. Issues the
code already had, and issues in files the change did not touch, are not in it. It does not read or write
`rigour-fix-packet.json`.

It returns plain text, not JSON, so that a large packet does not flood the agent's context:

- A header: what the change was read against, how many items must be fixed and how many are notes, the instruction (fix
  every must-fix item, notes are optional, do not edit files outside the change unless a must-fix item names them,
  re-run `rigour_check` after), the page range and `next_offset` (a number, or `none` on the last page).
- **Must fix (blocks you)** first, then **Notes (optional)**, under their own headings on every page. Each item: its
  shown severity and title, the check and its certainty, the exact `file:line`, the problem and the fix.
- The call to make for the next page, or a closing line telling the agent to re-run `rigour_check`.

`rigour_check` with no files reads the change the same way: `FAIL` means the agent has something to fix in its change,
never old debt elsewhere. With `files`, or a deep review, it checks those files as they are.

Because each call reviews again, the items and their order can change after the agent edits files. Start again at
`offset` 0 after editing.

An `offset` or `limit` outside those ranges returns an error, and nothing is scanned.
