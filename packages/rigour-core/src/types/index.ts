import { z } from 'zod';

/** A model name handed to an agent CLI as an argument: one that starts with "-" would be read as a flag. */
const ModelName = z.string().regex(/^[\w.:/@][\w.:/@-]*$/, 'a model name (letters, digits and . : / @ -), not starting with -');

export const GatesSchema = z.object({
    max_file_lines: z.number().optional().default(500),
    forbid_todos: z.boolean().optional().default(true),
    forbid_fixme: z.boolean().optional().default(true),
    required_files: z.array(z.string()).optional().default([
        'docs/SPEC.md',
        'docs/ARCH.md',
        'docs/DECISIONS.md',
        'docs/TASKS.md',
    ]),
    ast: z.object({
        complexity: z.number().optional().default(10),
        max_methods: z.number().optional().default(10),
        max_params: z.number().optional().default(5),
    }).optional().default({}),
    staleness: z.object({
        enabled: z.boolean().optional().default(false),
        // Rule-based staleness detection (toggle individual rules)
        rules: z.record(z.boolean()).optional().default({
            'no-var': true,              // var → const/let (ES6+)
            'no-commonjs': false,        // require() → import
            'no-arguments': false,       // arguments → rest params
            'prefer-arrow': false,       // function → arrow function
            'prefer-template': false,    // 'a' + b → `a${b}`
            'prefer-spread': false,      // apply() → spread
            'prefer-rest': false,        // arguments → ...args
            'prefer-const': false,       // let (unchanged) → const
        }),
    }).optional().default({}),
    dependencies: z.object({
        forbid: z.array(z.string()).optional().default([]),
        detect_unused: z.boolean().optional().default(true),
        detect_heavy_alternatives: z.boolean().optional().default(true),
        detect_duplicate_purpose: z.boolean().optional().default(true),
        unused_allowlist: z.array(z.string()).optional().default([]),
    }).optional().default({}),
    architecture: z.object({
        boundaries: z.array(z.object({
            from: z.string(),
            to: z.string(),
            mode: z.enum(['allow', 'deny']).default('deny'),
        })).optional().default([]),
    }).optional().default({}),
    safety: z.object({
        max_files_changed_per_cycle: z.number().optional().default(10),
        protected_paths: z.array(z.string()).optional().default(['.github/**', 'docs/**', 'rigour.yml']),
    }).optional().default({}),
    context: z.object({
        enabled: z.boolean().optional().default(true),
        sensitivity: z.number().min(0).max(1).optional().default(0.8), // 0.8 correlation threshold
        mining_depth: z.number().optional().default(100), // Number of files to sample
    }).optional().default({}),
    environment: z.object({
        enabled: z.boolean().optional().default(true),
        enforce_contracts: z.boolean().optional().default(true), // Auto-discovery of versions from truth sources
        tools: z.record(z.string()).optional().default({}), // Explicit overrides
        required_env: z.array(z.string()).optional().default([]),
    }).optional().default({}),
    retry_loop_breaker: z.object({
        enabled: z.boolean().optional().default(true),
        max_retries: z.number().optional().default(3), // Fail after 3 consecutive failures in same category
        doc_sources: z.record(z.string()).optional().default({}), // Custom doc URLs per category
    }).optional().default({}),
    agent_team: z.object({
        enabled: z.boolean().optional().default(false),
        max_concurrent_agents: z.number().optional().default(3),
        task_ownership: z.enum(['strict', 'collaborative']).optional().default('strict'),
    }).optional().default({}),
    checkpoint: z.object({
        enabled: z.boolean().optional().default(false),
        interval_minutes: z.number().optional().default(15),
        quality_threshold: z.number().optional().default(80),
        drift_detection: z.boolean().optional().default(true),
    }).optional().default({}),
    security: z.object({
        enabled: z.boolean().optional().default(true),
        sql_injection: z.boolean().optional().default(true),
        xss: z.boolean().optional().default(true),
        path_traversal: z.boolean().optional().default(true),
        hardcoded_secrets: z.boolean().optional().default(true),
        insecure_randomness: z.boolean().optional().default(true),
        command_injection: z.boolean().optional().default(true),
        block_on_severity: z.enum(['critical', 'high', 'medium', 'low']).optional().default('high'),
        /** Opt in: every pattern blocks. By default only a credential in a real secret's format blocks; the rest are notes. */
        block: z.boolean().optional().default(false),
    }).optional().default({}),
    frontend_secret_exposure: z.object({
        enabled: z.boolean().optional().default(true),
        block_on_severity: z.enum(['critical', 'high', 'medium', 'low']).optional().default('high'),
        check_process_env: z.boolean().optional().default(true),
        check_import_meta_env: z.boolean().optional().default(true),
        secret_env_name_patterns: z.array(z.string()).optional().default([
            '(?:^|_)(?:secret|private)(?:_|$)',
            '(?:^|_)(?:token|api[_-]?key|access[_-]?key|client[_-]?secret|signing|webhook)(?:_|$)',
            '(?:^|_)(?:db[_-]?url|database[_-]?url|connection[_-]?string)(?:_|$)',
        ]),
        safe_public_prefixes: z.array(z.string()).optional().default([
            'NEXT_PUBLIC_',
            'VITE_',
            'PUBLIC_',
            'NUXT_PUBLIC_',
            'REACT_APP_',
        ]),
        frontend_path_patterns: z.array(z.string()).optional().default([
            '(^|/)pages/(?!api/)',
            '(^|/)components/',
            '(^|/)src/components/',
            '(^|/)src/views/',
            '(^|/)src/app/',
            '(^|/)app/(?!api/)',
            '(^|/)views/',
            '(^|/)public/',
        ]),
        server_path_patterns: z.array(z.string()).optional().default([
            '(^|/)pages/api/',
            '(^|/)src/pages/api/',
            '(^|/)app/api/',
            '(^|/)src/app/api/',
            '\\.server\\.(?:ts|tsx|js|jsx|mjs|cjs)$',
        ]),
        allowlist_env_names: z.array(z.string()).optional().default([]),
    }).optional().default({}),
    // v2.16+ AI-Native Drift Detection Gates
    duplication_drift: z.object({
        enabled: z.boolean().optional().default(true),
        similarity_threshold: z.number().min(0).max(1).optional().default(0.8),
        min_body_lines: z.number().optional().default(5),
    }).optional().default({}),
    hallucinated_imports: z.object({
        enabled: z.boolean().optional().default(true),
        ignore_patterns: z.array(z.string()).optional().default([
            '\\.css$', '\\.scss$', '\\.less$', '\\.svg$', '\\.png$', '\\.jpg$',
            '\\.json$', '\\.wasm$', '\\.graphql$', '\\.gql$',
        ]),
    }).optional().default({}),
    inconsistent_error_handling: z.object({
        enabled: z.boolean().optional().default(true),
        max_strategies_per_type: z.number().optional().default(2),
        min_occurrences: z.number().optional().default(3),
        ignore_empty_catches: z.boolean().optional().default(false),
    }).optional().default({}),
    context_window_artifacts: z.object({
        enabled: z.boolean().optional().default(true),
        min_file_lines: z.number().optional().default(180),
        degradation_threshold: z.number().min(0).max(1).optional().default(0.55),
        signals_required: z.number().optional().default(4),
    }).optional().default({}),
    promise_safety: z.object({
        enabled: z.boolean().optional().default(true),
        check_unhandled_then: z.boolean().optional().default(true),
        check_unsafe_parse: z.boolean().optional().default(false), // opt-in: a regex cannot tell trusted JSON (own files, own serializer) from untrusted input
        check_async_without_await: z.boolean().optional().default(true),
        check_unsafe_fetch: z.boolean().optional().default(true),
        ignore_patterns: z.array(z.string()).optional().default([]),
    }).optional().default({}),
    // v3.1+ Extended Hallucination Detection
    phantom_apis: z.object({
        enabled: z.boolean().optional().default(true),
        check_node: z.boolean().optional().default(true),
        check_python: z.boolean().optional().default(true),
        check_go: z.boolean().optional().default(true),
        check_csharp: z.boolean().optional().default(true),
        check_java: z.boolean().optional().default(true),
        ignore_patterns: z.array(z.string()).optional().default([]),
    }).optional().default({}),
    deprecated_apis: z.object({
        enabled: z.boolean().optional().default(true),
        check_node: z.boolean().optional().default(true),
        check_python: z.boolean().optional().default(true),
        check_web: z.boolean().optional().default(true),
        check_go: z.boolean().optional().default(true),
        check_csharp: z.boolean().optional().default(true),
        check_java: z.boolean().optional().default(true),
        block_security_deprecated: z.boolean().optional().default(false),
        ignore_patterns: z.array(z.string()).optional().default([]),
    }).optional().default({}),
    test_quality: z.object({
        enabled: z.boolean().optional().default(true),
        check_empty_tests: z.boolean().optional().default(true),
        check_tautological: z.boolean().optional().default(true),
        check_mock_heavy: z.boolean().optional().default(true),
        check_assertion_free_async: z.boolean().optional().default(true),
        max_mocks_per_test: z.number().optional().default(5),
    }).optional().default({}),
    // v4.2+ Memory & Skills Governance
    governance: z.object({
        enabled: z.boolean().optional().default(true),
        /**
         * Block agent writes to native memory files (CLAUDE.md, …) and point to rigour_remember.
         * Off by default: teams edit their agent instructions deliberately; their content is still scanned for secrets.
         */
        enforce_memory: z.boolean().optional().default(false),
        /** Block agent writes to native skills/rules files (.cursor/rules, …). Off by default, like enforce_memory. */
        enforce_skills: z.boolean().optional().default(false),
        /** Block writes and tell agent to use rigour_remember / rigour_recall */
        block_native_memory: z.boolean().optional().default(true),
        /** Agent-native MEMORY paths — where agents auto-save context (glob patterns) */
        protected_memory_paths: z.array(z.string()).optional().default([
            // Claude Code — auto-memory
            'CLAUDE.md',
            '.claude/CLAUDE.md',
            // Cline — editable rules (agent can write)
            '.clinerules',
            '.clinerules/**',
            // Windsurf — auto-generated memories
            '.windsurf/memories/**',
            // Generic
            '.github/copilot-instructions.md',
        ]),
        /** Agent-native SKILLS/RULES paths — where agents store instructions/skills */
        protected_skills_paths: z.array(z.string()).optional().default([
            // Claude Code — skills, rules, commands
            '.claude/skills/**',
            '.claude/rules/**',
            '.claude/commands/**',
            // Cursor — rules and prompts
            '.cursorrules',
            '.cursor/rules/**',
            '.cursor/prompts/**',
            // Cline — rules directory
            '.cline/rules/**',
            // Windsurf — rules
            '.windsurf/rules/**',
            '.windsurfrules',
            // Copilot — instructions
            '.github/instructions/**',
            'copilot-instructions.md',
        ]),
        /** Paths that are exempt from governance (e.g. Rigour's own hook configs) */
        exempt_paths: z.array(z.string()).optional().default([
            '.claude/settings.json',   // Rigour's own hook config
            '.cursor/hooks.json',      // Rigour's own hook config
            '.windsurf/hooks.json',    // Rigour's own hook config
        ]),
    }).optional().default({}),
    // v4.3+ Side-Effect Safety Analysis
    // On by default: full scans of three real repositories reported no finding that was not a real defect.
    // A supabase-js read no index can serve, proved from the repository's own migrations (advisory, off by default).
    unindexed_reads: z.object({
        enabled: z.boolean().optional().default(false),
        migrations: z.array(z.string()).optional().default([]),
    }).optional().default({}),
    // A dependency whose installed version npm marks deprecated (advisory, off by default: it asks the registry).
    deprecated_dependencies: z.object({
        enabled: z.boolean().optional().default(false),
        registry: z.string().optional(),
    }).optional().default({}),
    // A migration added on a branch that sorts before the newest one on the base (advisory, off by default).
    /** Exports the change adds that no other file names (review/unused-exports.ts). */
    unused_exports: z.object({
        enabled: z.boolean().optional().default(true),
        allow: z.array(z.string()).optional().default([]), // export names a tool loads by name
        // Block on them. Off by default: teams routinely approve exports kept for tests or for a signature; a team whose reviewers block on them turns it on.
        block: z.boolean().optional().default(false),
    }).optional().default({}),
    /** Query shapes that cost production: offset paging in a loop, a time window with no upper bound (review/query-patterns.ts). */
    query_patterns: z.object({ enabled: z.boolean().optional().default(true) }).optional().default({}),
    /** What a fix leaves half done: the narrower condition still used elsewhere, a prop wired into some sibling mounts only, an accumulator copied every step (review/partial-fixes.ts, partial-wiring.ts, loop-copies.ts). */
    change_sweep: z.object({ enabled: z.boolean().optional().default(true) }).optional().default({}),
    /**
     * What a change made redundant, from the project's own TypeScript (review/typed/redundancy.ts): a null filter beside a
     * range on the same column, a nullable row type the query filters non-null, an optional member every host supplies, a
     * property written and never read. Runs at push, in `rigour review` and in a backtest (the program takes seconds to build).
     * `wire_contracts`: files whose types another service reads, so their members are never write-only here.
     * `schema_migrations`: folders of SQL migrations (relative, absolute, or `~/`; another repository's is fine, read only)
     * replayed to learn which columns are NOT NULL, for the nullable-not-null-column note. Missing folders are skipped.
     */
    redundancy: z.object({
        enabled: z.boolean().optional().default(true),
        wire_contracts: z.array(z.string()).optional().default([]),
        schema_migrations: z.array(z.string()).optional().default(['supabase/migrations']),
    }).optional().default({}),
    /** A parameter the change adds as optional that only tests omit (review/optional-params.ts). */
    optional_params: z.object({ enabled: z.boolean().optional().default(true) }).optional().default({}),
    /** A changed function whose body duplicates another in the files the change touched (review/duplicate-functions.ts). */
    duplicate_functions: z.object({ enabled: z.boolean().optional().default(true) }).optional().default({}),
    /** Code files the change adds that nothing imports or runs (review/orphan-files.ts). */
    orphan_files: z.object({
        enabled: z.boolean().optional().default(true),
        allow: z.array(z.string()).optional().default([]), // globs for files a tool loads by path
        // Block on them. Off by default, like unused_exports.block: a team whose reviewers block on dead files turns it on.
        block: z.boolean().optional().default(false),
    }).optional().default({}),
    /** Verified lessons a person compiled into checks (review-learning/compiled-lessons.ts): notes unless `block`. */
    compiled_lessons: z.object({
        enabled: z.boolean().optional().default(true),
        block: z.boolean().optional().default(false),
    }).optional().default({}),
    migration_order: z.object({
        enabled: z.boolean().optional().default(false),
        dirs: z.array(z.string()).optional().default(['**/supabase/migrations']),
    }).optional().default({}),
    semantic_bugs: z.object({
        enabled: z.boolean().optional().default(true),
        rules: z.array(z.string()).optional(),
    }).optional().default({}),
    side_effect_analysis: z.object({
        enabled: z.boolean().optional().default(true),
        check_unbounded_timers: z.boolean().optional().default(true),
        check_unbounded_loops: z.boolean().optional().default(true),
        check_process_lifecycle: z.boolean().optional().default(true),
        check_recursive_depth: z.boolean().optional().default(true),
        check_resource_lifecycle: z.boolean().optional().default(true),
        check_retry_without_limit: z.boolean().optional().default(true),
        check_circular_triggers: z.boolean().optional().default(true),
        check_auto_restart: z.boolean().optional().default(true),
        /** Opt in: the critical rules (unbounded I/O loop, circular trigger, restart bomb) block. By default every finding is a note. */
        block: z.boolean().optional().default(false),
        ignore_patterns: z.array(z.string()).optional().default([]),
    }).optional().default({}),
    // v5.1+ Style Drift Detection
    style_drift: z.object({
        enabled: z.boolean().optional().default(true),
        deviation_threshold: z.number().min(0).max(1).optional().default(0.25),
        sample_size: z.number().optional().default(100),
        baseline_path: z.string().optional().default('.rigour/style-baseline.json'),
    }).optional().default({}),
    // v5.1+ Logic Drift Foundation
    logic_drift: z.object({
        enabled: z.boolean().optional().default(true),
        baseline_path: z.string().optional().default('.rigour/logic-baseline.json'),
        track_operators: z.boolean().optional().default(true),
        track_branches: z.boolean().optional().default(false), // opt-in: counts change on purpose in most edits
        track_returns: z.boolean().optional().default(false),  // opt-in: same
    }).optional().default({}),
    // Model review. Whether it runs, the tier, the provider and its key come from flags and the person's settings, never from a committed file.
    deep: z.object({
        max_tokens: z.number().optional(), // default per provider: local 1024, cloud 4096
        temperature: z.number().optional().default(0.1),
        timeout_ms: z.number().optional(), // per model call; default: cloud 120s, local 60s, local --max 240s
        budget_ms: z.number().optional(), // whole deep run; files not started in time are reported as skipped
        agentic: z.boolean().optional(), // cloud tier: the model may read the repository while it reviews (default true)
        repo_rules: z.boolean().optional(), // show the model review, the agent review list and the stop hook the rules in AGENTS.md / CLAUDE.md / Cursor rules that name what the change touches (default false); the reviewer always checks them
        review_lessons: z.enum(['verified', 'all', 'off']).optional(), // the team's past review lessons: they raise a function's risk and are shown to the reviewer. verified (default), all, or off
        router: z.object({ // cloud tier: review only the riskiest changed functions (deep/risk.ts)
            enabled: z.boolean().optional(), // default true
            min_score: z.number().optional(), // functions below this get the deterministic gates only
            max_functions: z.number().optional(), // at most this many functions go to the model
        }).optional(),
        // Intent questions at engine-proven sites (optional-read-no-fallback) in scoped reviews.
        // Off: the stock local models failed the zero-false-finding bar (docs/DEEP_ANALYSIS.md).
        intent_checks: z.boolean().optional().default(false),
        checks: z.object({
            solid: z.boolean().optional().default(true),
            dry: z.boolean().optional().default(true),
            design_patterns: z.boolean().optional().default(true),
            language_idioms: z.boolean().optional().default(true),
            error_handling: z.boolean().optional().default(true),
            test_quality: z.boolean().optional().default(true),
            architecture: z.boolean().optional().default(true),
            code_smells: z.boolean().optional().default(true),
        }).optional().default({}),
    }).optional().default({}),
});

export const CommandsSchema = z.object({
    format: z.string().optional(),
    lint: z.string().optional(),
    typecheck: z.string().optional(),
    test: z.string().optional(),
});

export const HooksSchema = z.object({
    /** Stop hook: hold "done" until the agent acknowledges each risky changed function (rigour_review_ack). */
    require_review_ack: z.boolean().optional().default(false),
}).optional().default({});

export const ConfigSchema = z.object({
    preset: z.string().optional(),
    paradigm: z.string().optional(),
    commands: CommandsSchema.optional().default({}),
    gates: GatesSchema.optional().default({}),
    hooks: HooksSchema,
    output: z.object({
        report_path: z.string().default('rigour-report.json'),
    }).optional().default({}),
    /** The briefing an agent gets before it writes (rigour brief, the prompt hook, rigour_brief). */
    brief: z.object({
        /** The kill switch: false stops every briefing, including an installed hook. The hook itself is installed only with `rigour hooks init --brief`. */
        enabled: z.boolean().optional().default(true),
        /** At most this many items, never more than 10. */
        max_items: z.number().int().min(1).max(10).optional().default(10),
    }).optional().default({}),
    /** What Rigour learns from, beyond the reviews themselves. */
    learning: z.object({
        /** What happened after each pull request merged (outcomes/outcome.ts): CI on the merge commit, later commits on its files, a revert. */
        outcomes: z.object({
            /** off, on, or required (no person, environment variable or flag may turn it off). */
            mode: z.enum(['off', 'on', 'required']).optional().default('off'),
            /** How long after a merge later commits count, in days. */
            window_days: z.number().int().min(7).max(90).optional().default(30),
            /** How many later pull requests, independent and settled clean after a review found them repeating a lesson, demote it (review-learning/outcome-evidence.ts). */
            demote_after: z.number().int().min(2).optional().default(2),
        }).optional().default({}),
    }).optional().default({}),
    /** rigour review / rigour_review / the PR bot / the stop hook. */
    review: z.object({
        /** Let heuristic gates decide the verdict too; by default only findings that prove a defect do (quiet.ts). */
        include_heuristics: z.boolean().optional().default(false),
        /** Also report findings the base already had; by default only what the change introduced is (baseline.ts). */
        show_preexisting: z.boolean().optional().default(false),
        /**
         * The model reviewer accounts for every changed unit (function, or hunk named by its enclosing code): a
         * finding, or what it checked and why it holds. A unit left out gets one follow-up run, then is reported as
         * not reviewed (review/reviewer/coverage.ts). Applies only when the reviewer runs.
         */
        coverage: z.boolean().optional().default(true),
        /**
         * Check the change against the goal its pull request's description declares (goal/goal.ts): a changed file
         * outside the declared Scope or inside Out of scope, a "Done when" item naming a file or symbol the change never
         * touches. Deterministic; a finding blocks. `required` stops a person, the environment or a flag turning it off.
         */
        goal: z.enum(['off', 'on', 'required']).optional().default('off'),
        /** The GitHub account whose token fetches the pull request's previous review (`gh auth token --user`). */
        github_account: z.string().optional(),
        /** The reviewer (review/reviewer.ts): the person's own coding-agent CLIs, headless and read-only. `enabled` runs it at push; `rigour review --reviewer` runs it on request. */
        reviewer: z.object({
            enabled: z.boolean().optional().default(false),
            /**
             * At push, once the deterministic gates pass: `background` (default) starts the model review of the pushed
             * commit without holding the push; `wait` holds the push for it; `off` reviews only on request. Either way
             * a model is asked only when the branch has an open, non-draft pull request (someone will read the push).
             */
            on_push: z.enum(['background', 'wait', 'off']).optional().default('background'),
            /** The adapters, in order: claude, cursor, codex. */
            reviewers: z.array(z.string()).optional().default(['claude']),
            /** single: the first installed reviewer. cross: prefer a vendor not on the commits' trailers. full: two vendors, verdicts merged. */
            mode: z.enum(['single', 'cross', 'full']).optional().default('single'),
            /** The model for the claude reviewer. */
            model: ModelName.optional(),
            /** A model per reviewer name, e.g. { cursor: "auto" }. */
            models: z.record(ModelName).optional().default({}),
            timeout_ms: z.number().optional().default(15 * 60_000),
            /**
             * With two vendors: match their findings, cross-examine only what one raised, and block only on what is
             * confirmed (review/reviewer/panel.ts). `on` implies mode full. `required`: no user or run may turn it off,
             * and a run without two vendors is unavailable instead of falling back to one.
             */
            panel: z.enum(['off', 'on', 'required']).optional().default('off'),
            /** No user or run may review with fewer than the team's mode (a protected branch, CI). */
            mode_required: z.boolean().optional().default(false),
            /**
             * Whether people may dismiss a reviewer finding as not a bug (`rigour dismiss <id>`, Studio). Off by default:
             * a wrong finding is fixed by improving the reviewer, a right one by fixing the code. A team decision only.
             */
            dismissals: z.boolean().optional().default(false),
            /**
             * Review only the parts a change needs, picked without a model, usually in one pass (reviewer/orchestrator.ts,
             * triage.ts): off, on, or required (no person, environment variable or flag may turn it off). Experimental.
             */
            orchestrator: z.enum(['off', 'on', 'required']).optional().default('off'),
            /** Findings cross-examined per review at most; the rest are shown as disputed. */
            panel_max_items: z.number().int().positive().optional().default(20),
            /**
             * Spending caps per repository and local day, unset by default. Runs are checked before any judge starts
             * (a cross-examination counts too); dollars are the ones the CLIs reported, so a cap stops new reviews once
             * reached. Past a cap a review is skipped, or unavailable when the team requires the reviewer.
             */
            max_runs_per_day: z.number().int().positive().optional(),
            max_usd_per_day: z.number().positive().optional(),
            /** Judges in a full or panel review, each from a different vendor; capped by the vendors installed. */
            judges: z.union([z.literal(2), z.literal(3)]).optional().default(2),
            /**
             * When a full or panel review adds judges. `always`: every review. `risk`: only when the change has a
             * risky function (the router's score), a human review exists, or the run is the --full hard stop; any
             * other change gets one judge. Measured against `always` by the backtest before you rely on it.
             */
            escalate: z.enum(['always', 'risk']).optional().default('always'),
            /** A model per reviewer name for cross-examination (a narrow verification task), e.g. { claude: "haiku" }. */
            cross_models: z.record(ModelName).optional().default({}),
            /**
             * Cheap-model-first (reviewer/tiering.ts), off unless set: a cheaper model per reviewer name for a change with no
             * risk signal. Experimental: not to be recommended until a backtest shows what the cheap model misses.
             */
            tiers: z.object({ cheap: z.record(ModelName).optional().default({}) }).optional().default({}),
            /** Reasoning effort per reviewer name where the CLI or API takes one (codex, api): low, medium or high. */
            reasoning: z.record(z.enum(['low', 'medium', 'high'])).optional().default({}),
            /**
             * A judge reached through a model API (OpenAI-compatible chat completions with tools), named `api` in
             * `reviewers`: any model the team can call. The key is read from the environment variable `key_env`, never
             * from this file. `vendor` is the model's maker, for cross and full modes (inferred from the model name when unset).
             */
            api: z.object({
                url: z.string().url(),
                model: z.string().min(1),
                key_env: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'an environment variable name').optional().default('RIGOUR_JUDGE_API_KEY'),
                vendor: z.enum(['anthropic', 'openai', 'google', 'other']).optional(),
                max_turns: z.number().int().positive().optional().default(60),
            }).optional(),
            /**
             * Environment variables a judge's CLI must not see, per reviewer name, e.g. { codex: { unset: [OPENAI_API_KEY] } }
             * when that variable holds a key meant for another service. RIGOUR_API_KEY is never passed to a judge.
             */
            judge_env: z.record(z.object({ unset: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'an environment variable name')).optional().default([]) })).optional().default({}),
        }).optional().default({}),
    }).optional().default({}),
    ignore: z.array(z.string()).optional().default([]),
});

export type Gates = z.infer<typeof GatesSchema>;
export type Commands = z.infer<typeof CommandsSchema>;
export type Hooks = z.infer<typeof HooksSchema>;
export type Config = z.infer<typeof ConfigSchema>;

export type RawGates = z.input<typeof GatesSchema>;
export type RawCommands = z.input<typeof CommandsSchema>;
export type RawHooks = z.input<typeof HooksSchema>;
export type RawConfig = z.input<typeof ConfigSchema>;

export const StatusSchema = z.enum(['PASS', 'FAIL', 'SKIP', 'ERROR']);
export type Status = z.infer<typeof StatusSchema>;

export const SeveritySchema = z.enum(['critical', 'high', 'medium', 'low', 'info']);
export type Severity = z.infer<typeof SeveritySchema>;

/** Provenance tags — lets dashboards/agents filter by what matters */
export const ProvenanceSchema = z.enum(['ai-drift', 'traditional', 'security', 'governance', 'deep-analysis']);
export type Provenance = z.infer<typeof ProvenanceSchema>;

/** Severity weights for score calculation */
export const SEVERITY_WEIGHTS: Record<Severity, number> = {
    critical: 20,
    high: 10,
    medium: 5,
    low: 2,
    info: 0,
};

export const FailureSchema = z.object({
    id: z.string(),
    title: z.string(),
    details: z.string(),
    severity: SeveritySchema.optional(),
    provenance: ProvenanceSchema.optional(),
    files: z.array(z.string()).optional(),
    line: z.number().optional(),
    endLine: z.number().optional(),
    /** The changed line a finding about its enclosing changed function is posted on. */
    anchorLine: z.number().optional(),
    hint: z.string().optional(),
    // Deep analysis fields
    confidence: z.number().min(0).max(1).optional(), // LLM confidence score
    source: z.enum(['ast', 'llm', 'hybrid']).optional(), // Finding source
    category: z.string().optional(), // e.g. 'srp_violation', 'god_function'
    verified: z.boolean().optional(), // AST-verified LLM finding
    /** A proven check the team keeps as a note (its `block: false`): shown, never blocking. */
    advisory: z.boolean().optional(),
    /**
     * How sure the check is that the defect exists, set by the rule that found it: proven (it traced the defect or
     * states a fact) blocks on a changed line; likely is shown, never blocking; possible is a hint. Severity says how
     * bad the defect would be, never whether it blocks. Unset: the gate-level rule decides (review/quiet.ts mustFix).
     */
    certainty: z.enum(['proven', 'likely', 'possible']).optional(),
    /** Every line a finding that groups a file's violations names: one on a changed line puts it in the change, anchored there (review/changed-lines.ts). */
    lines: z.array(z.number()).optional(),
});
export type Failure = z.infer<typeof FailureSchema>;

export const ReportSchema = z.object({
    status: StatusSchema,
    summary: z.record(StatusSchema),
    /** Why a check reported SKIP: it could not check (for example, no main branch to compare with). */
    skips: z.record(z.string()).optional(),
    failures: z.array(FailureSchema),
    stats: z.object({
        duration_ms: z.number(),
        score: z.number().optional(),
        ai_health_score: z.number().optional(),
        structural_score: z.number().optional(),
        code_quality_score: z.number().optional(), // Deep analysis score
        severity_breakdown: z.record(z.number()).optional(),
        provenance_breakdown: z.object({
            'ai-drift': z.number(),
            traditional: z.number(),
            security: z.number(),
            governance: z.number(),
            'deep-analysis': z.number(),
        }).optional(),
        deep: z.object({
            enabled: z.boolean(),
            /** ok: every inference ran; partial: some failed; error: deep did not run. */
            status: z.enum(['ok', 'partial', 'error']).optional(),
            mode: z.enum(['facts', 'code']).optional(),
            tier: z.enum(['deep', 'lite', 'legacy', 'max', 'cloud']).optional(),
            model: z.string().optional(),
            model_fallback: z.boolean().optional(),
            total_ms: z.number().optional(),
            files_analyzed: z.number().optional(),
            chunks_total: z.number().optional(),
            chunks_failed: z.number().optional(),
            error: z.string().optional(),
            findings_proposed: z.number().optional(), // code mode, before the self-check
            findings_withdrawn: z.number().optional(), // by the self-check
            /** Findings the grounding check dropped, by reason. */
            findings_rejected: z.record(z.number()).optional(),
            /** Files a run budget (`gates.deep.budget_ms`) left unreviewed. */
            files_skipped: z.number().optional(),
            /** Repository lookups the model made in an agentic review. */
            tool_calls: z.number().optional(),
            /** Cloud router: changed functions ranked, how many went to the model, files it left to the gates. */
            router: z.object({ functions: z.number(), routed: z.number(), files_skipped: z.number(), already_reviewed: z.number() }).optional(),
            input_tokens: z.number().optional(),
            output_tokens: z.number().optional(),
            /** Provider-reported cost when available, else tokens × list price; undefined for an unpriced model. */
            cost_usd: z.number().optional(),
            findings_count: z.number().optional(),
            findings_verified: z.number().optional(),
        }).optional(),
    }),
});
export type Report = z.infer<typeof ReportSchema>;

/** Options passed from CLI --deep / --pro / --max / -k flags */
export interface DeepOptions {
    enabled: boolean;
    pro?: boolean;
    /** Local 7B model: the strongest free tier, for laptops with 16GB. */
    max?: boolean;
    /** A local GGUF to run instead of the tier's published model (evaluating a fine-tune before release). */
    modelPath?: string;
    apiKey?: string;
    provider?: string; // 'local' or any cloud provider name
    apiBaseUrl?: string; // custom API endpoint
    modelName?: string; // cloud model name override
    agents?: number; // Number of parallel agents (default: 1). Cloud-only. Each gets own provider instance.
    maxFiles?: number; // Max files to analyze in deep mode (default: 2000). Configurable via rigour.yml: deep.maxFiles
    focusLines?: Record<string, number[]>; // Changed lines per cwd-relative file (from a diff); reviewed first in code mode
    /** Lines the change removed per file, anchored at the new-side line (from a diff). */
    removedLines?: Record<string, Array<{ line: number; text: string[] }>>;
    /** What the change intends (a PR description): reference for the stronger tiers. */
    prBody?: string;
    /**
     * Review every risky changed function, ignoring the review ledger and reviewed.json. Those
     * record what an agent said it reviewed; an enforcing check reviews independently.
     */
    independent?: boolean;
    /** The change's unified diff (from reviewChange): a cloud agentic review reads the PR as a whole. */
    diff?: string;
    /** What Rigour's checks already found on the change's lines (the review and the runner fill it): settled, never reported again. */
    settled?: Array<{ file: string; line?: number; title: string; kind?: string }>;
    /** The lessons the team's compiled checks covered on this change: the deep review is told so instead of the lesson. */
    covered?: Array<{ checkId: string; lessonId: string; message: string }>;
}
